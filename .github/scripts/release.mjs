import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2026-03-10';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class GitHub {
  constructor({ sourceToken, infraToken, fetchImpl = fetch, pause = sleep, deadline = Date.now() + 30 * 60_000 }) {
    this.sourceToken = sourceToken;
    this.infraToken = infraToken;
    this.fetch = fetchImpl;
    this.pause = pause;
    this.deadline = deadline;
  }

  async request(path, { infra = false, method = 'GET', body, missing = false } = {}) {
    const token = infra ? this.infraToken : this.sourceToken;
    if (!token) throw new Error(`Missing ${infra ? 'INFRA_TOKEN' : 'GHCR_TOKEN'}.`);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= this.deadline) throw new Error('GitHub operation exceeded its deadline.');
      let response;
      try {
        response = await this.fetch(`https://api.github.com${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(30_000, this.deadline - Date.now())),
        });
      } catch (error) {
        // Do not blindly repeat a commit/dispatch whose response was lost.
        if (method !== 'GET' || attempt === 2) throw new Error(`GitHub ${method} request failed: ${error.name}. Retry the job; its handoff is idempotent.`);
        await this.pause(1000 * (attempt + 1));
        continue;
      }
      if (response.status === 404 && missing) return null;
      if (response.status === 204) return null;
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      if (response.ok) return data;
      if (method === 'GET' && [429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await this.pause(Math.min(30_000, Number(response.headers.get('retry-after') || attempt + 1) * 1000));
        continue;
      }
      const error = new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}: ${data?.message || 'request rejected'}`);
      error.status = response.status;
      throw error;
    }
  }
}

export function parseTag(tag, app) {
  const match = new RegExp(`^${app}-([a-f0-9]{40})-r([1-9][0-9]*)-([1-9][0-9]*)-a([1-9][0-9]*)$`).exec(tag);
  return match ? { sha: match[1], runNumber: BigInt(match[2]), runId: match[3], attempt: BigInt(match[4]) } : null;
}

export function parseImage(image, owner, app) {
  const prefix = `ghcr.io/${owner.toLowerCase()}/${app}:`;
  if (!image.startsWith(prefix)) throw new Error('Image must belong to this application GHCR package.');
  const [tag, digest, extra] = image.slice(prefix.length).split('@');
  const release = parseTag(tag, app);
  if (!release || extra || !/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Image must have a canonical release tag and SHA256 digest.');
  return { image, tag, digest, ...release };
}

export function readImageEnv(content, owner, app) {
  const key = `${app.toUpperCase()}_IMAGE`;
  const lines = content.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
  if (lines.length !== 1 || !lines[0].startsWith(`${key}=`)) throw new Error(`Release file must contain only ${key}=<image>.`);
  const value = lines[0].slice(key.length + 1);
  return value ? parseImage(value, owner, app) : null;
}

function output(name, value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error('Unexpected multiline job output.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
}

function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

export async function desiredImage(api, context, ref = 'main') {
  const file = await api.request(`/repos/${context.infraRepo}/contents/apps/${context.app}/image.env?ref=${encodeURIComponent(ref)}`, { infra: true });
  return { file, release: readImageEnv(Buffer.from(file.content, 'base64').toString('utf8'), context.owner, context.app) };
}

export async function packageVersions(api, context) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await api.request(`/orgs/${context.owner}/packages/container/${context.app}/versions?per_page=100&page=${page}`, { missing: true });
    if (!batch) {
      if (page !== 1) throw new Error('Package disappeared while listing versions; no pruning performed.');
      return [];
    }
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
}

export function publishedVersions(versions, app) {
  const latestTag = version => version.metadata.container.tags.map(tag => parseTag(tag, app)).filter(Boolean)
    .sort((a, b) => a.runNumber === b.runNumber ? (a.attempt === b.attempt ? 0 : a.attempt > b.attempt ? -1 : 1) : a.runNumber > b.runNumber ? -1 : 1)[0];
  return versions.filter(version => version.metadata?.container?.tags?.some(tag => parseTag(tag, app)))
    .sort((a, b) => {
      const left = latestTag(a), right = latestTag(b);
      return left.runNumber === right.runNumber ? (left.attempt === right.attempt ? Date.parse(b.created_at) - Date.parse(a.created_at) : left.attempt > right.attempt ? -1 : 1) : left.runNumber > right.runNumber ? -1 : 1;
    });
}

export async function deploymentState(api, context) {
  const healthy = [];
  let latest;
  for (let page = 1; ; page++) {
    const records = await api.request(`/repos/${context.infraRepo}/deployments?task=deploy-${context.app}&environment=prod&per_page=100&page=${page}`, { infra: true });
    if (!Array.isArray(records)) throw new Error('Invalid deployment history; refusing cleanup.');
    for (const record of records) {
      if (record.task !== `deploy-${context.app}` || record.environment !== 'prod' || record.payload?.app !== context.app) throw new Error('Unexpected deployment record; refusing cleanup.');
      const statuses = await api.request(`/repos/${context.infraRepo}/deployments/${record.id}/statuses?per_page=1`, { infra: true });
      if (!Array.isArray(statuses)) throw new Error('Invalid deployment status; refusing cleanup.');
      const image = parseImage(record.payload.image, context.owner, context.app);
      const state = statuses[0]?.state;
      latest ??= { id: record.id, image: image.image, state };
      // A failure is not evidence that the server never switched containers.
      if (latest.state !== 'success') return { latest, healthy, safe: false };
      if (state === 'success' && !healthy.some(item => item.digest === image.digest)) healthy.push(image);
      if (healthy.length === 2) return { latest, healthy, safe: true };
    }
    if (records.length < 100) return { latest, healthy, safe: Boolean(latest && healthy.length) };
  }
}

export async function assertCurrentSource(api, context, wanted) {
  if (!context.sourceSha) return; // Explicit context is supplied by the workflow CLI.
  if (wanted && wanted.sha !== context.sourceSha) throw new Error('Image source does not match this workflow commit.');
  const branch = await api.request(`/repos/${context.owner}/${context.app}/git/ref/heads/main`);
  if (branch?.object?.sha !== context.sourceSha) throw new Error('This source commit was superseded on main; refusing release.');
}

async function prune(api, context, versions, retainedIds, expectedImage, expectedDeploymentId) {
  let deleted = 0;
  for (const version of versions) {
    if (retainedIds.has(String(version.id))) continue;
    // A manual infra edit may occur while pruning. Never delete its newly desired image.
    const current = (await desiredImage(api, context)).release;
    const state = await deploymentState(api, context);
    if (!state.safe || state.latest.id !== expectedDeploymentId || state.latest.image !== current?.image || current?.image !== expectedImage) {
      report('Release was superseded during cleanup; remaining versions were left untouched.');
      break;
    }
    if (current?.digest === version.name) continue;
    await api.request(`/orgs/${context.owner}/packages/container/${context.app}/versions/${version.id}`, { method: 'DELETE', missing: true });
    deleted++;
  }
  report(`Deleted ${deleted} obsolete ${context.app} package version(s).`);
}

export async function prepublish(api, context) {
  await assertCurrentSource(api, context);
  // Read infra and fully paginate BEFORE the first destructive operation.
  const desired = (await desiredImage(api, context)).release;
  const versions = await packageVersions(api, context);
  const state = await deploymentState(api, context);
  if (!state.safe || state.latest.image !== desired?.image) {
    report('No confirmed healthy desired deployment; prepublication pruning skipped.');
    return { kept: new Set(), skipped: true };
  }
  const keep = protectedVersions(versions, state.healthy);
  await prune(api, context, versions, keep, desired.image, state.latest.id);
  return { kept: keep, skipped: false };
}

function protectedVersions(versions, images) {
  const ids = new Set();
  for (const image of images) {
    const version = versions.find(item => item.name === image.digest);
    if (!version) throw new Error('A protected healthy image is missing from GHCR; refusing cleanup.');
    ids.add(String(version.id));
  }
  return ids;
}

export async function cleanup(api, context, image) {
  const built = parseImage(image, context.owner, context.app);
  const desired = (await desiredImage(api, context)).release;
  if (desired?.image !== image) {
    report('Cleanup belongs to a superseded release; no package versions deleted.');
    return;
  }
  const versions = await packageVersions(api, context);
  const current = versions.find(version => version.name === built.digest);
  if (!current) throw new Error('Built image no longer exists; refusing destructive cleanup.');
  // A later publish-only release leaves infra unchanged. An older cleanup retry
  // must still leave that newer publication available for its own promotion.
  if (versions.some(version => version.metadata?.container?.tags?.some(tag => {
    const release = parseTag(tag, context.app);
    return release && isNewer(release, built);
  }))) {
    report('A newer image was published; this older cleanup leaves all versions untouched.');
    return;
  }
  const state = await deploymentState(api, context);
  if (!state.safe || state.latest.image !== image) {
    report('Deployment is failed, unresolved, or no longer current; cleanup skipped.');
    return;
  }
  const keep = protectedVersions(versions, [...state.healthy, built]);
  await prune(api, context, versions, keep, image, state.latest.id);
}

export function isNewer(current, wanted) {
  return current.runNumber > wanted.runNumber || (current.runNumber === wanted.runNumber && current.attempt > wanted.attempt);
}

async function findRun(api, context, image, commitSha) {
  let releaseCommit;
  if (!commitSha) {
    const history = await api.request(`/repos/${context.infraRepo}/commits?sha=main&path=apps/${context.app}/image.env&per_page=1`, { infra: true });
    releaseCommit = history[0]?.sha;
    if (!releaseCommit) throw new Error('Cannot establish the current image file commit; refusing to reuse a historical deployment.');
  }
  const query = commitSha ? `&head_sha=${encodeURIComponent(commitSha)}` : '';
  const data = await api.request(`/repos/${context.infraRepo}/actions/workflows/deploy-${context.app}.yml/runs?branch=main&per_page=100${query}`, { infra: true });
  const runs = data.workflow_runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (commitSha) return runs[0] || null;
  // Also recognize an operator's manual recovery after unrelated infra commits.
  for (const run of runs.slice(0, 20)) {
    if (!['push', 'workflow_dispatch'].includes(run.event)) continue;
    if (run.head_sha !== releaseCommit) {
      const comparison = await api.request(`/repos/${context.infraRepo}/compare/${releaseCommit}...${run.head_sha}`, { infra: true });
      if (!['ahead', 'identical'].includes(comparison.status)) continue;
    }
    const candidate = (await desiredImage(api, context, run.head_sha)).release;
    if (candidate?.image === image) return run;
  }
  return null;
}

async function assertDeployedRun(api, context, run) {
  for (let page = 1; ; page++) {
    const data = await api.request(`/repos/${context.infraRepo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`, { infra: true });
    const job = data.jobs.find(job => job.name === `Deploy ${context.app}`);
    if (job) {
      if (job.conclusion === 'success' && job.steps?.some(step => step.name === 'Deploy application' && step.conclusion === 'success')) return;
      break;
    }
    if (data.jobs.length < 100) break;
  }
  throw new Error('Infra run did not complete its actual application deployment step; cleanup is skipped.');
}

export async function waitForRun(api, context, run, pause = sleep) {
  report(`Infra deployment: ${run.html_url}`);
  while (Date.now() < api.deadline) {
    const latest = await api.request(`/repos/${context.infraRepo}/actions/runs/${run.id}`, { infra: true });
    if (latest.status === 'completed') {
      if (latest.conclusion !== 'success') throw new Error(`Infra deployment ${latest.conclusion}; cleanup is skipped. Retry the app deploy job or dispatch infra manually: ${latest.html_url}`);
      await assertDeployedRun(api, context, latest);
      report('Infra deployment succeeded.');
      return latest;
    }
    await pause(10_000);
  }
  throw new Error('Infra deployment did not complete within 30 minutes; cleanup is skipped. Check the linked infra run before retrying.');
}

export async function deploy(api, context, image, { allowRetry = false, pause = sleep } = {}) {
  const wanted = parseImage(image, context.owner, context.app);
  await assertCurrentSource(api, context, wanted);
  // A deleted registry image must never be promoted merely because job outputs survived.
  const versions = await packageVersions(api, context);
  if (!versions.some(version => version.name === wanted.digest && version.metadata?.container?.tags?.includes(wanted.tag))) {
    throw new Error('Built image is missing from GHCR. Run the full application pipeline to publish a new immutable image.');
  }
  let commitSha;
  let changed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await assertCurrentSource(api, context, wanted);
    const { file, release: current } = await desiredImage(api, context);
    if (current && isNewer(current, wanted)) throw new Error('This release was superseded by a newer application release; refusing to rewind infra.');
    if (current?.image === image) break;
    try {
      const updated = await api.request(`/repos/${context.infraRepo}/contents/apps/${context.app}/image.env`, {
        infra: true, method: 'PUT', body: { branch: 'main', sha: file.sha,
          message: `deploy(${context.app}): ${wanted.tag}`,
          content: Buffer.from(`${context.app.toUpperCase()}_IMAGE=${image}\n`).toString('base64') },
      });
      commitSha = updated.commit.sha;
      changed = true;
      break;
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === 4) throw error;
      await pause(1000 * (attempt + 1));
    }
  }
  let run;
  if (changed) {
    const discoveryDeadline = Math.min(api.deadline, Date.now() + 120_000);
    while (Date.now() < discoveryDeadline) {
      run = await findRun(api, context, image, commitSha);
      if (run) break;
      await pause(5000);
    }
  } else {
    run = await findRun(api, context, image);
  }
  if (run?.status === 'completed' && run.conclusion === 'success') {
    await assertDeployedRun(api, context, run);
    report(`Existing infra deployment already succeeded: ${run.html_url}`);
    return run;
  }
  if (run && run.status !== 'completed') return waitForRun(api, context, run, pause);
  if (!allowRetry) {
    if (run) return waitForRun(api, context, run, pause);
    throw new Error('No infra deployment appeared within 120 seconds. Check infra workflow setup and retry the app deploy job.');
  }
  // Dispatch only on an explicit job retry, never loop over failing deployments.
  const stillDesired = (await desiredImage(api, context)).release;
  if (stillDesired?.image !== image) throw new Error('Release changed before retry dispatch; refusing stale deployment.');
  const dispatched = await api.request(`/repos/${context.infraRepo}/actions/workflows/deploy-${context.app}.yml/dispatches`, {
    infra: true, method: 'POST', body: { ref: 'main', inputs: { expected_image: image, apply_shared: false } },
  });
  if (!dispatched?.workflow_run_id) throw new Error('GitHub did not return the dispatched run ID; check infra Actions before retrying.');
  return waitForRun(api, context, { id: dispatched.workflow_run_id, html_url: dispatched.html_url }, pause);
}

async function main() {
  const [owner, app, extra] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const infraRepo = process.env.INFRA_REPO;
  if (extra || !/^[A-Za-z0-9-]+$/.test(owner || '') || !['backend', 'frontend'].includes(app)) throw new Error('Expected GITHUB_REPOSITORY=<organization>/backend or frontend.');
  if (infraRepo !== `${owner}/infra`) throw new Error('INFRA_REPO must be the organization\'s infra repository.');
  const command = process.argv[2];
  const api = new GitHub({ sourceToken: process.env.GHCR_TOKEN, infraToken: process.env.INFRA_TOKEN,
    deadline: Date.now() + (command === 'deploy' ? 30 : 4) * 60_000 });
  const context = { owner, app, infraRepo, sourceSha: command === 'maintenance' ? undefined : process.env.GITHUB_SHA };
  if (command !== 'maintenance' && !/^[a-f0-9]{40}$/.test(context.sourceSha || '')) throw new Error('GITHUB_SHA must be a full source commit.');
  if (['prepublish', 'maintenance'].includes(command)) await prepublish(api, context);
  else if (command === 'cleanup') await cleanup(api, context, process.env.IMAGE_REF || '');
  else if (command === 'deploy') await deploy(api, context, process.env.IMAGE_REF || '', {
    allowRetry: Number(process.env.GITHUB_RUN_ATTEMPT) > Number(process.env.BUILD_ATTEMPT),
  });
  else throw new Error('Expected prepublish, deploy, cleanup or maintenance.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
