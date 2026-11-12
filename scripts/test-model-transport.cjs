// Simulated provider responses; never calls a paid model or reads a real API key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('async function callLLM'), html.indexOf('function typewriter'));

function environment(response, backendMode = false) {
  const requests = [];
  const ctx = vm.createContext({
    backendMode, modelBackendBase: '', modelRequiresPlaySession: false, TextDecoder,
    getSettings: () => ({ apiBase: 'https://provider.invalid/v1', apiKey: 'test-placeholder', model: 'test-model' }),
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return response; }
  });
  vm.runInContext(source, ctx);
  return { ctx, requests, run: code => vm.runInContext(code, ctx) };
}
function sse(content, finishReason = 'stop', newline = true) {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] }) +
    (newline ? '\n\ndata: [DONE]\n\n' : ''), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('complete streams including an EOF-only final event preserve text and default chat options', async () => {
  for (const newline of [true, false]) {
    const { run, requests } = environment(sse('{"script_name":"完整故事"}', 'stop', newline));
    assert.equal(await run('callLLM([], null)'), '{"script_name":"完整故事"}');
    assert.equal(requests[0].body.temperature, 0.8);
    assert.equal(requests[0].body.max_tokens, undefined);
  }
});

test('generation options reach both direct and backend proxy requests', async () => {
  for (const backend of [false, true]) {
    const { run, requests } = environment(sse('{}'), backend);
    await run('callLLM([], null, {temperature: 0.4, maxTokens: 8192})');
    assert.equal(requests[0].body.temperature, 0.4);
    assert.equal(requests[0].body.max_tokens, 8192);
    if (backend) assert.equal(requests[0].url, '/api/chat');
    else assert.equal(requests[0].body.model, 'test-model');
  }
});

test('stream and non-stream length limits report incomplete output even when JSON looks complete', async () => {
  for (const response of [sse('{}', 'length', false), new Response(JSON.stringify({ choices: [
    { message: { content: '{}' }, finish_reason: 'length' }
  ] }), { headers: { 'Content-Type': 'application/json' } })]) {
    const { run } = environment(response);
    await assert.rejects(run('callLLM([], null)'), error => {
      assert.equal(error.code, 'MODEL_OUTPUT_LENGTH');
      assert.equal(error.partialText, '{}');
      return true;
    });
  }
});

test('provider stream errors and filtered responses do not masquerade as missing story fields', async () => {
  const streamError = new Response('data: ' + JSON.stringify({ error: { message: 'provider failed' } }) + '\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(environment(streamError).run('callLLM([], null)'), /模型生成中断/);
  await assert.rejects(environment(sse('', 'content_filter')).run('callLLM([], null)'), /调整主题或背景/);
});

test('backend forwards the generation token budget with an upper bound', async () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = server.indexOf('async function handleChat');
  const end = server.indexOf('\nconst server =', start);
  let upstreamBody, errorResponse;
  const ctx = vm.createContext({
    Buffer,
    loadConfig: () => ({ apiBase: 'https://provider.invalid', apiKey: 'test-placeholder', model: 'test-model' }),
    readBody: async () => JSON.stringify({ messages: [{ role: 'user', content: 'Create a plan' }], temperature: 0.4, max_tokens: 20000 }),
    sendJson: (res, status, error) => { errorResponse = { status, error }; },
    fetch: async (url, options) => {
      upstreamBody = JSON.parse(options.body);
      return { ok: true, body: (async function* () { yield Buffer.from('data: [DONE]\n\n'); })() };
    }
  });
  vm.runInContext(server.slice(start, end), ctx);
  ctx.response = { writeHead() {}, write() {}, end() {} };
  await vm.runInContext('handleChat({}, response)', ctx);
  assert.equal(errorResponse, undefined);
  assert.equal(upstreamBody.max_tokens, 8192);
  assert.equal(upstreamBody.temperature, 0.4);
});
