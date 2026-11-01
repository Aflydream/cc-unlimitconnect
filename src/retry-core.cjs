'use strict';
// Local Bun preload for Claude Code. No listener, TLS interception or payload logs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const RETRY_STATUSES = new Set([408, 409, 429, ...Array.from({length: 100}, (_, i) => 500 + i)]);

function matchesRetryRequest(input, init, policy) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return url.origin === policy.allowed_origin && method === 'POST' &&
      (policy.request_paths || ['/v1/messages', '/v1/messages/count_tokens']).includes(url.pathname);
  } catch { return false; }
}

function disableRetryEnvelopeTimeout(Client, policy) {
  if (policy.max_retries !== 'unlimited') return;
  const originalFetchWithTimeout = Client.prototype.fetchWithTimeout;
  const originalMakeAbort = Client.prototype._makeAbort;
  if (typeof originalFetchWithTimeout !== 'function' || typeof originalMakeAbort !== 'function') {
    throw new Error('The Claude SDK timeout hooks differ from the verified adapter');
  }
  const envelopes = new WeakMap();
  Client.prototype.fetchWithTimeout = async function (input, init, timeout, controller, ...rest) {
    const matching = matchesRetryRequest(input, init, clientPolicy(policy, this));
    if (matching) envelopes.set(controller, init?.signal);
    try {
      return await originalFetchWithTimeout.call(this, input, init, timeout, controller, ...rest);
    } finally { if (matching) envelopes.delete(controller); }
  };
  Client.prototype._makeAbort = function (controller) {
    const abort = originalMakeAbort.call(this, controller);
    if (!envelopes.has(controller)) return abort;
    const upstream = envelopes.get(controller);
    // The SDK invokes this callback without arguments for its envelope timer,
    // and with an abort event for cancellation. Keep all caller cancellation;
    // each transport attempt below owns its separate timeout instead.
    return event => { if (event || upstream?.aborted) return abort(event); };
  };
}

function streamErrorStatus(event) {
  if (event?.type !== 'error' && !event?.error) return null;
  const error = event.error || event;
  const status = Number(error.status || event.status);
  if (RETRY_STATUSES.has(status)) return status;
  if (error.type === 'overloaded_error') return 529;
  if (error.type === 'rate_limit_error') return 429;
  if (['api_error','server_error','timeout_error','connection_error'].includes(error.type)) return 503;
  return null;
}

async function inspectBeforeOutput(response) {
  const type = response.headers.get('content-type') || '';
  if (!response.body || !type.includes('text/event-stream')) return {response, errorStatus: null};
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let text = '', bytes = 0, done = false, errorStatus = null, meaningful = false;
  while (!done && !meaningful && errorStatus === null && bytes < 262144) {
    let next;
    try { next = await reader.read(); }
    catch (error) { try { await reader.cancel(error); } catch {} throw error; }
    done = next.done;
    if (!next.value) continue;
    chunks.push(next.value);bytes += next.value.byteLength;
    text += decoder.decode(next.value, {stream:true}).replace(/\r\n/g,'\n');
    let index;
    while ((index = text.indexOf('\n\n')) >= 0) {
      const block = text.slice(0,index);text = text.slice(index+2);
      const data = block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let event;
      try { event = JSON.parse(data); } catch { meaningful = true;break; }
      const status = streamErrorStatus(event);
      if (status !== null) { errorStatus = status;break; }
      if ((event.type === 'content_block_start' && event.content_block?.type === 'tool_use') ||
          event.type === 'content_block_delta' || event.type === 'message_delta' || event.type === 'message_stop' ||
          (event.type === 'message_start' && event.message?.content?.length)) { meaningful = true;break; }
    }
  }
  // Return every byte unchanged once output begins. A later stream failure must
  // not replay output/tool calls that the client may already have acted upon.
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      if (done) return;
      try {
        const next = await reader.read();
        if (next.done) {done=true;controller.close();} else controller.enqueue(next.value);
      } catch (error) {done=true;controller.error(error);}
    },
    cancel(reason) {done=true;return reader.cancel(reason);},
  });
  const restored = new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
  try {Object.defineProperty(restored,'url',{value:response.url});} catch {}
  return {response:restored,errorStatus};
}

function cancelled(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Request cancelled', 'AbortError');
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
}

function createRetryFetch(realFetch, policy, hooks = {}) {
  const maxRetries = policy.max_retries;
  const unlimited = maxRetries === 'unlimited';
  const delayMs = policy.delay_ms;
  const attemptTimeoutMs = policy.attempt_timeout_ms ?? 1800000;
  if ((!unlimited && (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 200)) || delayMs !== 3000 ||
      !Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 1800000) {
    throw new Error('Invalid fixed retry policy');
  }
  const wait = hooks.wait || waitForRetry;
  return async function fixedRetryFetch(input, init) {
    if (!matchesRetryRequest(input, init, policy)) {
      return realFetch(input, init);
    }
    // Buffer the outgoing request once in memory so a streamed request body can
    // be replayed safely. Response bodies are never replayed after delivery.
    const template = new Request(input, init);
    const signal = template.signal;
    const bytes = await template.arrayBuffer();
    const options = {
      ...init, method: template.method, headers: new Headers(template.headers),
      body: bytes.byteLength ? bytes : undefined, signal,
      cache: template.cache, credentials: template.credentials, mode: template.mode,
      redirect: template.redirect, referrer: template.referrer,
      referrerPolicy: template.referrerPolicy, integrity: template.integrity,
      keepalive: template.keepalive,
    };
    for (let retryCount = 0; ; retryCount++) {
      if (signal.aborted) throw cancelled(signal);
      let response, failure, semanticStatus = null;
      let timedOut = false;
      const attempt = unlimited ? new AbortController() : null;
      const attemptSignal = attempt ? AbortSignal.any([signal, attempt.signal]) : signal;
      const timer = attempt ? setTimeout(() => {
        timedOut = true; attempt.abort(new DOMException('API attempt timed out', 'TimeoutError'));
      }, attemptTimeoutMs) : null;
      try {
        response = await realFetch(template.url, {...options, signal:attemptSignal});
        if (response.ok) {
          const inspected = await inspectBeforeOutput(response);
          response = inspected.response;semanticStatus = inspected.errorStatus;
        }
      }
      catch (error) {
        if (signal.aborted || (!unlimited && error?.name === 'AbortError')) throw error;
        // Certificate errors and malformed options do not recover with retries.
        const code = error?.code || error?.cause?.code || '';
        if (/CERT|TLS|SSL|ERR_INVALID|ERR_UNSUPPORTED/i.test(String(code))) throw error;
        failure = timedOut ? new DOMException('API attempt timed out', 'TimeoutError') : error;
        response = undefined;
      }
      finally { if (timer !== null) clearTimeout(timer); }
      if (response && semanticStatus === null && !RETRY_STATUSES.has(response.status)) return response;
      if (!unlimited && retryCount >= maxRetries) {
        if (failure) throw failure;
        if (semanticStatus !== null) {
          try { await response?.body?.cancel(); } catch {}
          // Surface the stream's real error status to the SDK. Returning HTTP
          // 200 with a failed stream triggers Code's non-streaming fallback,
          // which would start a second retry budget after this one is exhausted.
          const errorType = semanticStatus === 529 ? 'overloaded_error' :
            semanticStatus === 429 ? 'rate_limit_error' : 'api_error';
          return new Response(JSON.stringify({type:'error',error:{type:errorType,
            message:'Provider stream failed before output; fixed retry budget exhausted.'}}),
            {status:semanticStatus,headers:{'content-type':'application/json'}});
        }
        return response;
      }
      const status = semanticStatus ?? response?.status ?? null;
      try { await response?.body?.cancel(); } catch {}
      // SDK progress requires a finite number. Its denominator is display-only;
      // the unlimited loop has no numeric retry limit.
      try { hooks.onRetry?.({attempt: retryCount + 1, max_retries: unlimited ? Number.MAX_SAFE_INTEGER : maxRetries,
        retry_delay_ms: delayMs, error_status: status,
        error: status === 429 ? 'rate_limit' : status === 529 ? 'overloaded' : status === null ? 'unknown' : 'server_error'}); } catch {}
      // Intentionally fixed: no exponential backoff, jitter or Retry-After override.
      await wait(delayMs, signal);
    }
  };
}

function sdkProgressReporter() {
  const args = process.argv.slice(1);
  const output = args.indexOf('--output-format');
  const streaming = output >= 0 && args[output + 1] === 'stream-json';
  let sessionId = '';
  for (const flag of ['--session-id', '--resume']) {
    const index = args.indexOf(flag);
    const value = index >= 0 ? args[index + 1] : '';
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value || '')) sessionId = value;
  }
  const originalWrite = process.stdout.write.bind(process.stdout);
  if (streaming) {
    process.stdout.write = function (chunk, ...rest) {
      // Only inspect init metadata, never store or log assistant/user content.
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      if (text.length < 262144 && /"subtype"\s*:\s*"init"/.test(text.slice(0,1500))) {
        for (const line of text.split('\n')) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') sessionId = event.session_id;
          } catch {}
        }
      }
      return originalWrite(chunk, ...rest);
    };
  }
  return info => {
    if (streaming && sessionId) originalWrite(JSON.stringify({type: 'system', subtype: 'api_retry',
      ...info, uuid: crypto.randomUUID(), session_id: sessionId}) + '\n');
  };
}

function configureNativeRetries(argv) {
  // The desktop passes inline --settings. Merge rather than discard its options.
  // These overrides apply only to this preloaded process, not other CLI clients.
  const overrides = {
    CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0',
    CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0', API_TIMEOUT_MS: '1800000',
    CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '1800000',
  };
  const index = argv.indexOf('--settings');
  let settings = {};
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) throw new Error('Missing desktop settings argument');
    settings = JSON.parse(value.trimStart().startsWith('{') ? value : fs.readFileSync(value, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid desktop settings');
  }
  settings.env = {...settings.env, ...overrides};
  if (index >= 0) argv[index + 1] = JSON.stringify(settings);
  else argv.push('--settings', JSON.stringify(settings));
  Object.assign(process.env, overrides);
}


function clientPolicy(policy, client) {
  if (policy.allowed_origin) return policy;
  const base = new URL(client.baseURL);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Unsupported API base URL for the retry adapter');
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  return {...policy, allowed_origin:base.origin,
    request_paths:[prefix+'/v1/messages',prefix+'/v1/messages/count_tokens']};
}

function installSDK(Client, policy) {
  const tag = Symbol.for('claude.local.fixed.retry');
  if (globalThis[tag]) throw new Error('Another Claude retry preload is already active');
  if (typeof Client !== 'function' || typeof Client.prototype.makeRequest !== 'function' ||
      typeof Client.prototype.fetchWithTimeout !== 'function' || typeof Client.prototype._makeAbort !== 'function' ||
      Object.getOwnPropertyDescriptor(Client.prototype, 'fetch')) {
    throw new Error('SDK differs from the verified retry adapter');
  }
  configureNativeRetries(process.argv);
  disableRetryEnvelopeTimeout(Client, policy);
  const transports = new WeakMap();
  const reporter = sdkProgressReporter();
  Object.defineProperty(Client.prototype,'fetch',{
    configurable:true, enumerable:true,
    get(){return transports.get(this);},
    set(value){
      if(typeof value!=='function')throw new Error('Invalid SDK transport');
      const raw = value[tag]?.raw || value;
      const client=this;
      const wrapped=function(input,init){
        return createRetryFetch(raw.bind(client),clientPolicy(policy,client),{onRetry:reporter})(input,init);
      };
      wrapped[tag]={raw};transports.set(client,wrapped);
    },
  });
  globalThis[tag]=true;
}

module.exports={createRetryFetch,waitForRetry,configureNativeRetries,disableRetryEnvelopeTimeout,clientPolicy,installSDK};
