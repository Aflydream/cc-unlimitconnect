'use strict';
const assert = require('node:assert/strict');
const {createRetryFetch, waitForRetry, configureNativeRetries, disableRetryEnvelopeTimeout} = require('../src/retry-core.cjs');
const policy = {allowed_origin: 'https://api.example.test', max_retries: 200, delay_ms: 3000};
const url = policy.allowed_origin + '/v1/messages';
const options = {method: 'POST', body: '{"offline":true}', headers: {'Authorization': 'Bearer synthetic-test'}};
(async () => {
  let calls = 0, waits = [], progress = [];
  let retry = createRetryFetch(async () => { calls++; return new Response('temporary', {status: 503, headers:{'Retry-After':'600'}}); }, policy,
    {wait: ms => { waits.push(ms); }, onRetry: info => progress.push(info)});
  assert.equal((await retry(url, options)).status, 503);
  assert.equal(calls, 201); assert.equal(waits.length, 200);
  assert.ok(waits.every(ms => ms === 3000)); assert.equal(progress[199].attempt, 200);
  calls = 0; waits = [];
  retry = createRetryFetch(async (input, init) => {
    calls++; assert.equal(Buffer.from(init.body).toString(), options.body);
    assert.equal(init.headers.get('Authorization'), 'Bearer synthetic-test');
    return new Response('response', {status: calls === 201 ? 200 : 529});
  }, policy, {wait: ms => {waits.push(ms);}});
  assert.equal((await retry(new Request(url, options))).status, 200);
  assert.equal(calls, 201); assert.equal(waits.length, 200);
  for (const status of [400, 401, 403, 404, 422]) {
    calls = 0;
    retry = createRetryFetch(async () => {calls++; return new Response('permanent', {status});}, policy, {wait: () => assert.fail()});
    assert.equal((await retry(url, options)).status, status); assert.equal(calls, 1);
  }
  calls = 0;
  retry = createRetryFetch(async () => {calls++; throw Object.assign(new Error('certificate'), {code:'CERT_HAS_EXPIRED'});}, policy, {wait: () => assert.fail()});
  await assert.rejects(retry(url, options)); assert.equal(calls, 1);
  calls = 0;
  retry = createRetryFetch(async () => {calls++; if(calls < 3) throw Object.assign(new Error('offline reset'), {code:'ECONNRESET'}); return new Response('ok');}, policy, {wait: ms => assert.equal(ms,3000)});
  assert.equal((await retry(url, options)).status, 200); assert.equal(calls, 3);
  calls = 0;
  retry = createRetryFetch(async () => {calls++; return new Response('other endpoint', {status:503});}, policy, {wait: () => assert.fail()});
  assert.equal((await retry('https://other.example/v1/messages', options)).status, 503); assert.equal(calls, 1);
  assert.equal((await retry(policy.allowed_origin+'/api/event_logging', options)).status, 503); assert.equal(calls, 2);
  const controller = new AbortController();
  const promise = waitForRetry(3000,controller.signal);controller.abort();await assert.rejects(promise, e=>e.name==='AbortError');
  calls = 0;
  retry = createRetryFetch(async () => {calls++; return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: partial\n\n'));c.error(new Error('stream dropped'));}}));}, policy,{wait:()=>assert.fail()});
  const stream = await retry(url,options);await assert.rejects(stream.text());assert.equal(calls,1);
  calls = 0; waits = [];
  const sseError = 'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"offline"}}\n\n';
  retry = createRetryFetch(async()=>{calls++;return new Response(sseError,{headers:{'content-type':'text/event-stream'}});},policy,{wait:ms=>waits.push(ms)});
  const exhausted = await retry(url,options);assert.equal(calls,201);assert.equal(waits.length,200);assert.equal(exhausted.status,529);assert.equal((await exhausted.json()).error.type,'overloaded_error');
  calls = 0;
  const partial = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'+sseError;
  retry = createRetryFetch(async()=>{calls++;return new Response(partial,{headers:{'content-type':'text/event-stream'}});},policy,{wait:()=>assert.fail()});
  assert.equal(await (await retry(url,options)).text(),partial);assert.equal(calls,1);
  calls = 0;
  retry = createRetryFetch(async()=>{
    calls++;
    if(calls < 3) return new Response(new ReadableStream({start(c){c.error(Object.assign(new Error('pre-output reset'),{code:'ECONNRESET'}));}}),{headers:{'content-type':'text/event-stream'}});
    return new Response(partial,{headers:{'content-type':'text/event-stream'}});
  },policy,{wait:ms=>assert.equal(ms,3000)});
  assert.equal(await (await retry(url,options)).text(),partial);assert.equal(calls,3);
  calls = 0;
  retry = createRetryFetch(async()=>{
    calls++;let step=0;
    return new Response(new ReadableStream({pull(c){if(step++===0)c.enqueue(new TextEncoder().encode(partial));else c.error(new Error('post-output reset'));}}),{headers:{'content-type':'text/event-stream'}});
  },policy,{wait:()=>assert.fail()});
  await assert.rejects((await retry(url,options)).text());assert.equal(calls,1);
  const args = ['claude.exe','--settings',JSON.stringify({permissions:{allow:['Read']},env:{DISABLE_TELEMETRY:'1',CLAUDE_CODE_MAX_RETRIES:'200'}}),'-p','test'];
  configureNativeRetries(args,policy);
  const merged = JSON.parse(args[2]);assert.deepEqual(merged.permissions,{allow:['Read']});
  assert.equal(merged.env.DISABLE_TELEMETRY,'1');assert.equal(merged.env.CLAUDE_CODE_MAX_RETRIES,'0');
  assert.equal(merged.env.CLAUDE_CODE_RETRY_WATCHDOG,'0');assert.equal(merged.env.API_TIMEOUT_MS,'1800000');
  const infinite = {...policy,max_retries:'unlimited'};
  for (const kind of ['http','sse','network']) {
    calls=0;let delayCount=0;
    retry=createRetryFetch(async()=>{
      calls++;
      if(calls===402)return new Response('recovered');
      if(kind==='network')throw Object.assign(new Error('temporary reset'),{code:'ECONNRESET'});
      return kind==='sse'?new Response(sseError,{headers:{'content-type':'text/event-stream'}}):new Response('temporary',{status:529});
    },infinite,{wait:ms=>{assert.equal(ms,3000);delayCount++;},onRetry:e=>assert.equal(e.max_retries,Number.MAX_SAFE_INTEGER)});
    assert.equal(await (await retry(url,options)).text(),'recovered');assert.equal(calls,402);assert.equal(delayCount,401);
  }
  calls=0;
  const stopped=new AbortController();
  retry=createRetryFetch(async()=>{calls++;return new Response('temporary',{status:503});},infinite,
    {wait:ms=>{assert.equal(ms,3000);if(calls===251)stopped.abort();}});
  await assert.rejects(retry(url,{...options,signal:stopped.signal}),e=>e.name==='AbortError');assert.equal(calls,251);
  for (const status of [400,401,403]) {
    calls=0;retry=createRetryFetch(async()=>{calls++;return new Response('permanent',{status});},infinite,{wait:()=>assert.fail()});
    assert.equal((await retry(url,options)).status,status);assert.equal(calls,1);
  }
  calls=0;let returnedSignal;
  retry=createRetryFetch(async(input,init)=>{
    calls++;
    if(calls===1)return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
    returnedSignal=init.signal;return new Response('timeout recovered');
  },{...infinite,attempt_timeout_ms:10},{wait:ms=>assert.equal(ms,3000)});
  const continued=new AbortController();
  assert.equal(await (await retry(url,{...options,signal:continued.signal})).text(),'timeout recovered');assert.equal(calls,2);
  continued.abort();assert.equal(returnedSignal.aborted,true);
  class FakeSDK {
    _makeAbort(c){return()=>c.abort();}
    async fetchWithTimeout(input,init,timeout,c){
      const abort=this._makeAbort(c);init?.signal?.addEventListener('abort',abort,{once:true});
      if(init?.signal?.aborted)abort();const timer=setTimeout(abort,timeout);
      try{return await waitForRetry(20,c.signal);}finally{clearTimeout(timer);}
    }
  }
  disableRetryEnvelopeTimeout(FakeSDK,infinite);
  const fake=new FakeSDK();const envelope=new AbortController();
  await fake.fetchWithTimeout(url,options,5,envelope);assert.equal(envelope.signal.aborted,false);
  await assert.rejects(fake.fetchWithTimeout('https://other.example/v1/messages',options,5,new AbortController()),e=>e.name==='AbortError');
  const cancelEnvelope=new AbortController();const cancelTimer=setTimeout(()=>cancelEnvelope.abort(),5);
  await assert.rejects(fake.fetchWithTimeout(url,{...options,signal:cancelEnvelope.signal},5,new AbortController()),e=>e.name==='AbortError');clearTimeout(cancelTimer);
  const cancelledAlready=new AbortController();cancelledAlready.abort();
  await assert.rejects(fake.fetchWithTimeout(url,{...options,signal:cancelledAlready.signal},5,new AbortController()),e=>e.name==='AbortError');
  console.log(JSON.stringify({unit_checks:'passed',unlimited_retries_past_200:401,http_sse_network_recovery:true,
    cancellation_stops_loop:true,attempt_timeout_retries:true,sdk_envelope_timeout_disabled_only_for_target:true,
    all_waits_ms:3000,payload_logging:false,external_requests:0}));
})().catch(error => {console.error(error.message);process.exitCode=1;});
