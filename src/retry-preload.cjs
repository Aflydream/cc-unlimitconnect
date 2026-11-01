'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

if(globalThis.Bun && path.basename(process.execPath).toLowerCase()==='claude.exe') {
  const policy=JSON.parse(fs.readFileSync(process.env.CLAUDE_UNLIMITED_RETRY_CONFIG || path.join(__dirname,'policy.json'),'utf8'));
  if(path.resolve(process.execPath).toLowerCase()===path.resolve(policy.verified_binary).toLowerCase()) {
    const hash=crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
    if(hash!==policy.binary_sha256)throw new Error('Code binary changed; re-run the patch installer to verify compatibility');
    const sdk=require(policy.sdk_module);
    require('./retry-core.cjs').installSDK(sdk[policy.sdk_export],policy);
    if(process.env.CLAUDE_UNLIMITED_RETRY_PROBE==='1')process.stderr.write('CLAUDE_UNLIMITED_RETRY_READY\n');
  }
}
