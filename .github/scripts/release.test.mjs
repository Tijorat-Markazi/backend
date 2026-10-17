import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, parseImage, readImageEnv, packageVersions, prepublish, cleanup, deploy, isNewer, deploymentState, assertCurrentSource } from './release.mjs';

const context = { owner: 'Tijorat-Markazi', app: 'backend', infraRepo: 'Tijorat-Markazi/infra' };
const image = (n = 5, attempt = 1) => `ghcr.io/tijorat-markazi/backend:backend-${'a'.repeat(40)}-r${n}-100-a${attempt}@sha256:${String(n).repeat(64)}`;
const version = n => ({ id: n, name: `sha256:${String(n).repeat(64)}`, created_at: `2026-10-${String(n).padStart(2, '0')}`, metadata: { container: { tags: [`backend-${'a'.repeat(40)}-r${n}-100-a1`] } } });
const file = value => ({ sha: 'blob-sha', content: Buffer.from(`BACKEND_IMAGE=${value}\n`).toString('base64') });
const success = { id: 90, head_sha: 'infra-sha', status: 'completed', conclusion: 'success', event: 'push', created_at: '2026-10-10', html_url: 'https://github.com/Tijorat-Markazi/infra/actions/runs/90' };
const jobs = { jobs: [{ name: 'Deploy backend', conclusion: 'success', steps: [{ name: 'Deploy application', conclusion: 'success' }] }] };
const record = (id, n, state = 'success') => ({ id, task: 'deploy-backend', environment: 'prod', payload: { app: 'backend', image: image(n) }, state });

function mock(handler, history = [record(50, 5), record(40, 4)]) {
  const calls = [];
  const api = new GitHub({ sourceToken: 'source-test-token', infraToken: 'infra-test-token', pause: async () => {}, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, ...options, json: options.body ? JSON.parse(options.body) : undefined });
    let result;
    if (path.includes('/deployments?')) result = history;
    else if (/\/deployments\/\d+\/statuses/.test(path)) {
      const entry = history.find(item => item.id === Number(/\/deployments\/(\d+)/.exec(path)[1]));
      result = entry?.state ? [{ state: entry.state }] : [];
    } else result = await handler(path, options, calls);
    if (result instanceof Error) throw result;
    const status = typeof result?.status === 'number' ? result.status : 200;
    return new Response(status === 204 ? null : JSON.stringify(result?.body ?? result), { status });
  } });
  return { api, calls };
}
const deleted = calls => calls.filter(c => c.method === 'DELETE').map(c => c.path.split('/').at(-1));
function releaseResponses(path) {
  if (path.includes('/jobs?')) return jobs;
  if (path.includes('/commits?')) return [{ sha: 'infra-sha' }];
  if (path.includes('/contents/')) return file(image());
  if (path.includes('/actions/workflows/')) return { workflow_runs: [success] };
  if (path.includes('/actions/runs/')) return success;
  return [version(5)];
}

test('canonical references enforce owner, app, full SHA, digest and ordering', () => {
  const parsed = parseImage(image(), context.owner, context.app);
  assert(isNewer(parseImage(image(6), context.owner, context.app), parsed));
  assert(isNewer(parseImage(image(5, 2), context.owner, context.app), parsed));
  assert.throws(() => parseImage(image().replace('tijorat-markazi', 'attacker'), context.owner, context.app));
  assert.throws(() => parseImage(image().split('@')[0], context.owner, context.app));
  assert.throws(() => readImageEnv(`BACKEND_IMAGE=${image()}\nEVIL=value`, context.owner, context.app));
  assert.equal(readImageEnv('# Initial publication\nBACKEND_IMAGE=\n', context.owner, context.app), null);
});

test('registry pagination completes before retention decisions', async () => {
  const { api, calls } = mock(path => path.includes('&page=1') ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, created_at: '2026-01-01', metadata: {} })) : [version(6)]);
  assert.equal((await packageVersions(api, context)).length, 101);
  assert.equal(calls.length, 2);
});

test('prepublication retains healthy pair instead of newest publications', async () => {
  const { api, calls } = mock((path, o) => path.includes('/contents/') ? file(image()) : o.method === 'DELETE' ? { status: 204 } : [1, 3, 4, 5].map(version));
  assert.deepEqual([...(await prepublish(api, context)).kept].sort(), ['4', '5']);
  assert.deepEqual(deleted(calls), ['3', '1']);
});

for (const state of ['failure', 'in_progress', 'pending', null]) test(`unresolved deployment (${state}) prevents all pruning`, async () => {
  const history = [record(60, 6, state), record(50, 5), record(40, 4)];
  const { api, calls } = mock(path => path.includes('/contents/') ? file(image(6)) : [1, 4, 5, 6].map(version), history);
  assert.equal((await prepublish(api, context)).skipped, true);
  await cleanup(api, context, image(6));
  assert.deepEqual(deleted(calls), []);
});

test('desired state ahead of healthy acknowledgement prevents prepublication deletion', async () => {
  const { api, calls } = mock(path => path.includes('/contents/') ? file(image(6)) : [1, 4, 5, 6].map(version));
  assert.equal((await prepublish(api, context)).skipped, true);
  assert.deepEqual(deleted(calls), []);
});

test('initial publication supports missing package and no deployment records', async () => {
  const { api, calls } = mock(path => path.includes('/contents/') ? file('') : { status: 404 }, []);
  assert.equal((await prepublish(api, context)).skipped, true);
  assert.deepEqual(deleted(calls), []);
});

test('cleanup keeps previous DISTINCT healthy release across repeated shared applies', async () => {
  const { api, calls } = mock((path, o) => path.includes('/contents/') ? file(image()) : o.method === 'DELETE' ? { status: 204 } : [1, 3, 4, 5].map(version), [record(51, 5), record(50, 5), record(40, 4)]);
  await cleanup(api, context, image());
  assert.deepEqual(deleted(calls), ['3', '1']);
});

test('missing protected healthy image aborts deletion', async () => {
  const { api, calls } = mock(path => path.includes('/contents/') ? file(image()) : [version(1), version(5)]);
  await assert.rejects(cleanup(api, context, image()), /protected healthy image is missing/);
  assert.deepEqual(deleted(calls), []);
});

test('stale cleanup and a later publish-only image both prevent deletion', async () => {
  for (const desired of [image(), image(6)]) {
    const { api, calls } = mock(path => path.includes('/contents/') ? file(desired) : [4, 5, 6].map(version));
    await cleanup(api, context, image());
    assert.deepEqual(deleted(calls), []);
  }
});

test('desired change during cleanup prevents even the first deletion', async () => {
  let reads = 0;
  const { api, calls } = mock(path => path.includes('/contents/') ? file(++reads > 1 ? image(6) : image()) : [1, 4, 5].map(version));
  await cleanup(api, context, image());
  assert.deepEqual(deleted(calls), []);
});

test('pagination error cannot trigger partial cleanup', async () => {
  const { api, calls } = mock(path => path.includes('/contents/') ? file(image()) : path.includes('&page=1') ? Array.from({ length: 100 }, () => version(1)) : { status: 403 });
  await assert.rejects(prepublish(api, context), /403/);
  assert.deepEqual(deleted(calls), []);
});

test('unchanged successful release makes no commit or dispatch', async () => {
  const { api, calls } = mock(releaseResponses);
  await deploy(api, context, image());
  assert(calls.every(c => c.method === 'GET'));
});

test('unchanged release joins existing running infra deployment', async () => {
  const { api, calls } = mock(path => path.includes('/actions/workflows/') ? { workflow_runs: [{ ...success, status: 'in_progress' }] } : releaseResponses(path));
  await deploy(api, context, image(), { pause: async () => {} });
  assert(calls.every(c => c.method === 'GET'));
});

test('failed original deployment does not loop recovery dispatches', async () => {
  const failed = { ...success, conclusion: 'failure' };
  const { api, calls } = mock(path => path.includes('/actions/workflows/') ? { workflow_runs: [failed] } : path.includes('/actions/runs/') ? failed : releaseResponses(path));
  await assert.rejects(deploy(api, context, image()), /cleanup is skipped/);
  assert(!calls.some(c => c.method === 'POST'));
});

test('explicit job retry dispatches once with the existing image', async () => {
  const { api, calls } = mock((path, o) => o.method === 'POST' ? { workflow_run_id: 91, html_url: success.html_url } : path.includes('/actions/workflows/') ? { workflow_runs: [{ ...success, conclusion: 'failure' }] } : releaseResponses(path));
  await deploy(api, context, image(), { allowRetry: true });
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].json, { ref: 'main', inputs: { expected_image: image(), apply_shared: false } });
});

test('stale deploy cannot rewind a newer infra image', async () => {
  const { api, calls } = mock(path => path.includes('/contents/') ? file(image(6)) : [version(5)]);
  await assert.rejects(deploy(api, context, image(), { allowRetry: true }), /superseded/);
  assert(calls.every(c => c.method === 'GET'));
});

test('source guard rejects old commits and mismatched image sources', async () => {
  const { api } = mock(() => ({ object: { sha: 'b'.repeat(40) } }));
  const source = { ...context, sourceSha: 'a'.repeat(40) };
  await assert.rejects(assertCurrentSource(api, source), /superseded/);
  await assert.rejects(assertCurrentSource(api, source, { sha: 'b'.repeat(40) }), /does not match/);
});

test('commit conflicts reread blob state before bounded retry', async () => {
  let commits = 0;
  const { api, calls } = mock((path, o) => o.method === 'PUT' ? ++commits === 1 ? { status: 409 } : { commit: { sha: 'infra-sha' } } : path.includes('/contents/') ? file(image(4)) : releaseResponses(path));
  await deploy(api, context, image(), { pause: async () => {} });
  assert.equal(commits, 2);
  assert.equal(calls.filter(c => c.path.includes('/contents/') && c.method === 'GET').length, 2);
});

test('five commit conflicts terminate without dispatch', async () => {
  const { api, calls } = mock((path, o) => o.method === 'PUT' ? { status: 409 } : path.includes('/contents/') ? file(image(4)) : releaseResponses(path));
  await assert.rejects(deploy(api, context, image(), { pause: async () => {} }), /409/);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 5);
  assert(!calls.some(c => c.method === 'POST'));
});

test('ambiguous mutation responses are never blindly retried', async () => {
  const { api, calls } = mock(() => new TypeError('Connection lost'));
  await assert.rejects(api.request('/repos/example/contents/file', { infra: true, method: 'PUT', body: {} }), /idempotent/);
  assert.equal(calls.length, 1);
});

test('expired deadline prevents the first request', async () => {
  const { api, calls } = mock(() => []);
  api.deadline = Date.now() - 1;
  await assert.rejects(packageVersions(api, context), /deadline/);
  assert.equal(calls.length, 0);
});

test('workflow success with a skipped deployment never authorizes cleanup', async () => {
  const { api } = mock(path => path.includes('/jobs?') ? { jobs: [{ name: 'Deploy backend', conclusion: 'skipped', steps: [] }] } : releaseResponses(path));
  await assert.rejects(deploy(api, context, image()), /actual application deployment/);
});

test('active run deadline fails safely without dispatch', async () => {
  const { api, calls } = mock(path => path.includes('/actions/workflows/') ? { workflow_runs: [{ ...success, status: 'in_progress' }] } : path.includes('/actions/runs/') ? { ...success, status: 'in_progress' } : releaseResponses(path));
  await assert.rejects(deploy(api, context, image(), { pause: async () => { api.deadline = Date.now() - 1; } }), /30 minutes/);
  assert(calls.every(c => c.method === 'GET'));
});

test('foreign deployment records cannot authorize cleanup', async () => {
  const bad = { ...record(50, 5), payload: { app: 'frontend', image: image() } };
  const { api } = mock(() => [], [bad]);
  await assert.rejects(deploymentState(api, context), /Unexpected deployment/);
});
