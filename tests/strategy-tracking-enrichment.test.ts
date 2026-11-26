import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fixture } from './fixtures.ts';
import { createTracker, validField, validProperties } from '../tracking/core.ts';
import { omEvents, studioEvents } from '../tracking/events.ts';
import { resumableDownload } from '../gateway/resumable-download.ts';
import {
  approvedCapabilityIds,
  extractHttpStatus,
  extractUpstreamErrorCode,
  mediaGenerationError,
  mediaGenerationErrorCategory,
  safeCapabilityId,
  superAgentError,
  toolInputFields,
  toolResultFields,
} from '../tracking/tool-fields.ts';
import { defaultCapabilities } from '../shared/capability-registry.ts';
import { withErrorMeta } from '../gateway/network.ts';
import type { HostContext } from '../tracking/host.ts';
import { ModelGateway } from '../gateway/service.ts';
import { Phase1Service } from '../phase1.ts';
import { pluginRoot } from '../hyperframes.ts';
import { ScenarioRuns } from '../gateway/scenario-runs.ts';
import { SuperAgentConversations } from '../gateway/super-agent.ts';
import { resolveCodexTraceSampleRate, shouldSampleCodexTurn } from '../shared/codex-session-tracking.ts';

function fakeTracker() {
  const events: any[] = [];
  const tracking = createTracker({
    registry: omEvents,
    entrypoint: 'mcp',
    enabled: true,
    flushIntervalMs: 0,
    send: async batch => {
      events.push(...batch);
      return 'accepted';
    },
  });
  return { tracking, events };
}

const codexHost: HostContext = {
  host_agent: 'codex',
  host_agent_source: 'mcp_client_info',
  mcp_client_name: 'codex-mcp-client',
  mcp_client_version: '1.2.3',
};

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=',
  'base64',
);

test('P0-A: media generation worker events carry provider/model/capability/duration/error_code/host_context and redact custom models', () => fixture(async store => {
  const { tracking, events } = fakeTracker();
  const gateway = new ModelGateway(store, {
    tracking,
    detect: async () => [{ id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'ok' }],
    codex: async () => png1x1,
    pollMs: 10,
  });

  // 1) Local agent (codex) success with capabilityId and host_context
  const job = await gateway.submit({
    modality: 'image',
    prompt: 'A minimalist studio poster',
    model: 'codex:image-generation',
    capabilityId: 'relight',
    library: { title: 'Test poster' },
  }, codexHost);
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(task => task.done));
  await tracking.flush();

  const reqEv = events.find(e => e.event === 'media_generation_requested');
  const subEv = events.find(e => e.event === 'media_generation_submitted' && e.properties.job_id === job.id);
  const resEv = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === job.id);

  assert.ok(reqEv, 'expected media_generation_requested');
  assert.equal(reqEv.properties.capability_id, 'relight');
  assert.equal(reqEv.host_context?.host_agent, 'codex');

  assert.ok(subEv, 'expected media_generation_submitted');
  assert.equal(subEv.properties.provider_kind, 'agent');
  assert.equal(subEv.properties.model_provider, 'codex');
  assert.equal(subEv.properties.model_id, 'image-generation');
  assert.equal(subEv.properties.capability_id, 'relight');
  assert.equal(subEv.properties.reference_count, 0);
  assert.equal(subEv.host_context?.host_agent, 'codex');

  assert.ok(resEv, 'expected media_generation_result');
  assert.equal(resEv.properties.job_state, 'completed');
  assert.equal(resEv.properties.provider_kind, 'agent');
  assert.equal(resEv.properties.model_provider, 'codex');
  assert.equal(resEv.properties.model_id, 'image-generation');
  assert.equal(resEv.properties.attempt_kind, 'initial');
  assert.equal(typeof resEv.properties.duration_ms, 'number');
  assert.equal(typeof resEv.properties.queue_wait_ms, 'number');
  assert.equal(resEv.properties.error_code, undefined);
  assert.equal(resEv.host_context?.host_agent, 'codex');

  // 2) Builtin vendor-path model_id validation and gateway retention
  assert.equal(validField('model_id', 'fal-ai/flux/schnell'), true);
  assert.equal(validField('model_id', 'fal-ai/wan/v2.2-a14b/text-to-video'), true);
  assert.equal(validField('model_id', '../invalid'), false);
  assert.equal(validField('model_id', '/etc/passwd'), false);
  assert.equal(validField('model_id', 'https://example.com/model'), false);
  assert.equal(validField('model_id', 'a/b/c/d/e/f'), false);

  const falGateway = new ModelGateway(store, {
    tracking,
    fetcher: async (url, init = {}) => {
      if (init.method === 'POST') return Response.json({ request_id: 'fal-1', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      if (String(url).endsWith('/s')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ outputs: ['https://cdn.example/out.png'] });
    },
    download: async () => png1x1,
    pollMs: 10,
  });
  await falGateway.configureProvider('fal', { apiKey: 'test-key' });
  const falJob = await falGateway.submit({
    modality: 'image',
    prompt: 'Builtin vendor path model',
    model: 'fal:fal-ai/flux/schnell',
    library: { title: 'Fal poster' },
  }, codexHost);
  await falGateway.tick();
  await Promise.all([...falGateway.active.values()].map(task => task.done));
  await tracking.flush();
  const falSub = events.find(e => e.event === 'media_generation_submitted' && e.properties.job_id === falJob.id);
  const falRes = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === falJob.id);
  assert.equal(falSub?.properties.provider_kind, 'builtin');
  assert.equal(falSub?.properties.model_provider, 'fal');
  assert.equal(falSub?.properties.model_id, 'fal-ai/flux/schnell');
  assert.equal(falRes?.properties.provider_kind, 'builtin');
  assert.equal(falRes?.properties.model_provider, 'fal');
  assert.equal(falRes?.properties.model_id, 'fal-ai/flux/schnell');
  await falGateway.close();

  // 3) Failure path maps closed error_code without raw message leakage
  assert.equal(mediaGenerationError(Object.assign(new Error('secret key sk-123 failed'), { status: 401 })), 'AUTH_REJECTED');
  assert.equal(mediaGenerationError(Object.assign(new Error('quota'), { status: 402 })), 'BALANCE_LOW');
  assert.equal(mediaGenerationError(new Error('Generation timed out')), 'TIMEOUT');
  assert.equal(mediaGenerationError(new Error('anything'), 'interrupted'), 'WORKER_INTERRUPTED');
  assert.equal(mediaGenerationError(new Error('anything'), 'cancelled'), 'CANCELLED');

  // 3) Custom compatible provider omits model_provider and model_id
  const customProviderId = await gateway.connections.configure(null, {
    label: 'Private Endpoint',
    baseUrl: 'https://private.example.com/v1',
    apiKey: 'secret-token',
    protocol: 'openai',
    enabled: true,
  });
  await gateway.connections.saveModel(customProviderId, {
    modelId: 'internal/secret-model-v9',
    label: 'Secret Model',
    kind: 'image',
    enabled: true,
  });
  const failingGateway = new ModelGateway(store, {
    tracking,
    fetcher: async () => new Response('unauthorized', { status: 401 }),
    pollMs: 10,
  });
  const customJob = await failingGateway.submit({
    modality: 'image',
    prompt: 'Private render',
    model: `${customProviderId}:internal/secret-model-v9`,
    library: { title: 'Private' },
  });
  await failingGateway.tick();
  await Promise.all([...failingGateway.active.values()].map(task => task.done));
  await tracking.flush();

  const customSub = events.find(e => e.event === 'media_generation_submitted' && e.properties.job_id === customJob.id);
  const customRes = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === customJob.id);
  assert.equal(customSub.properties.provider_kind, 'custom');
  assert.equal(customSub.properties.model_provider, undefined);
  assert.equal(customSub.properties.model_id, undefined);
  assert.equal(customRes.properties.provider_kind, 'custom');
  assert.equal(customRes.properties.model_provider, undefined);
  assert.equal(customRes.properties.model_id, undefined);
  assert.equal(customRes.properties.job_state, 'failed');
  assert.equal(customRes.properties.error_code, 'AUTH_REJECTED');

  await gateway.close();
  await failingGateway.close();
  tracking.close();
}, false));

test('P0-B: Capability Center toolInputFields and toolResultFields extract capability_id, executor_kind, dry_run and fallback_raw_model safely', () => {
  assert.equal(safeCapabilityId('remove-background'), 'remove-background');
  assert.equal(safeCapabilityId('custom/unsafe path!'), 'other');
  assert.equal(safeCapabilityId('secret-user-token-slug'), 'other');
  assert.equal(safeCapabilityId(''), undefined);

  assert.deepEqual(
    toolInputFields('openmotion_capability_run', { capabilityId: 'relight', dryRun: true }),
    { action: 'run', capability_id: 'relight', dry_run: true },
  );
  assert.deepEqual(
    toolInputFields('openmotion_capability_run', { model: 'fal:flux-pro', dryRun: false }),
    { action: 'run', dry_run: false, fallback_raw_model: true },
  );
  assert.deepEqual(
    toolResultFields('openmotion_capability_run', { capabilityId: 'remove-background' }, { capabilityId: 'remove-background', executorKind: 'prompt-preset', dryRun: true }),
    { capability_id: 'remove-background', executor_kind: 'prompt-preset', dry_run: true, fallback_raw_model: false },
  );
  assert.deepEqual(
    toolResultFields('openmotion_capability_run', { model: 'fal:flux-pro' }, { executorKind: 'model' }),
    { executor_kind: 'model', fallback_raw_model: true },
  );
  assert.equal(
    validProperties(omEvents, 'mcp_tool_finished', {
      tool_name: 'motion_capability_run',
      call_id: crypto.randomUUID(),
      accepted: true,
      action: 'run',
      capability_id: 'remove-background',
      executor_kind: 'prompt-preset',
      dry_run: true,
      fallback_raw_model: false,
      outcome: 'success',
      duration_ms: 120,
    }),
    true,
  );
});

test('P0-C: work_generation_stage and project_create_result carry template_id attribution and host_context', () => fixture(async store => {
  const { tracking, events } = fakeTracker();
  const service = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async task => task(),
    cancel: async () => {},
    tracking,
  });

  const created = await service.call('openmotion_create_project', {
    requestId: crypto.randomUUID(),
    projectType: 'template',
    templateId: 'decision-tree',
    title: 'Template Attributed Film',
    requirements: 'Demo',
  }, codexHost);

  const began = await service.call('openmotion_open_preview', {
    action: 'begin',
    projectId: created.projectId,
    requestId: crypto.randomUUID(),
    mode: 'create',
  }, codexHost);

  const film = `<!doctype html><html><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script><style>
body{margin:0}#main{position:relative;width:320px;height:180px;background:#14354a}
#title{color:white;font-size:28px}</style></head><body>
<div id="main" data-composition-id="main" data-start="0" data-duration="2" data-width="320" data-height="180" data-fps="24">
<div id="title" class="clip" data-start="0" data-duration="2" data-track-index="0">Attributed video</div></div><script>const tl=gsap.timeline({paused:true});tl.to('#title',{opacity:0.5,duration:2},0);window.__timelines={main:tl};</script></body></html>`;
  await writeFile(path.join(store.projectDirectoryFor(created.projectId), 'index.html'), film);
  const current = await service.call('openmotion_get_project', { projectId: created.projectId }, codexHost);
  await service.call('openmotion_open_preview', {
    action: 'complete_generation',
    projectId: created.projectId,
    workId: began.inlineWork.id,
    requestId: crypto.randomUUID(),
    expectedRevision: current.revision,
    expectedVersionId: current.currentVersionId,
  }, codexHost);
  await tracking.flush();

  const createEv = events.find(e => e.event === 'project_create_result');
  assert.equal(createEv?.properties.creation_route, 'template');
  assert.equal(createEv?.properties.template_id, 'decision-tree');
  assert.equal(createEv?.host_context?.host_agent, 'codex');

  const stageEvents = events.filter(e => e.event === 'work_generation_stage');
  assert.deepEqual(stageEvents.map(e => e.properties.stage), ['started', 'generated']);
  for (const ev of stageEvents) {
    assert.equal(ev.properties.template_id, 'decision-tree');
    assert.equal(ev.properties.attribution_source, 'project_catalog');
    assert.equal(ev.host_context?.host_agent, 'codex');
  }
  const hostStarted = events.find(e => e.event === 'host_run_started');
  assert.equal(hostStarted?.host_context?.host_agent, 'codex');
  tracking.close();
}, false));

test('P1-D: ScenarioRuns emits terminal scenario_run_result and scenario_step_result once without replay duplication', () => fixture(async store => {
  const { tracking, events } = fakeTracker();
  const runs = new ScenarioRuns(store.directory, store, tracking);

  const createReq = crypto.randomUUID();
  const { run } = await runs.create({ requestId: createReq, scenarioId: 'motion-full-chain' });
  // Idempotent replay must not duplicate scenario_run_result
  await runs.create({ requestId: createReq, scenarioId: 'motion-full-chain' });

  const firstStep = Object.keys(run.steps)[0]!;
  // Rejected mutations that throw after mutating status/archived must NOT emit success milestones
  await assert.rejects(
    runs.updateStep({
      runId: run.id,
      expectedRevision: run.revision,
      requestId: crypto.randomUUID(),
      stepId: firstStep,
      status: 'done',
      bindings: { reference: ['nonexistent-pool-item'] },
    }),
    /POOL_ITEM_NOT_FOUND|not found/i,
  );
  await assert.rejects(
    runs.updateRun({
      runId: run.id,
      expectedRevision: run.revision,
      requestId: crypto.randomUUID(),
      changes: { archived: true, activeStepId: 'nonexistent-step' },
    }),
    /Unknown step|not found/i,
  );

  const stepReq = crypto.randomUUID();
  const updated = await runs.updateStep({
    runId: run.id,
    expectedRevision: run.revision,
    requestId: stepReq,
    stepId: firstStep,
    status: 'done',
  });
  await runs.updateStep({
    runId: run.id,
    expectedRevision: run.revision,
    requestId: stepReq,
    stepId: firstStep,
    status: 'done',
  });

  await runs.updateRun({
    runId: run.id,
    expectedRevision: updated.run.revision,
    requestId: crypto.randomUUID(),
    changes: { archived: true },
  });
  await tracking.flush();

  const runEvents = events.filter(e => e.event === 'scenario_run_result');
  const stepEvents = events.filter(e => e.event === 'scenario_step_result');
  assert.deepEqual(runEvents.map(e => e.properties.action), ['create', 'archive']);
  assert.equal(runEvents[0].properties.scenario_id, 'motion-full-chain');
  assert.equal(runEvents[1].properties.completed_step_count, 1);

  assert.equal(stepEvents.length, 1);
  assert.equal(stepEvents[0].properties.scenario_id, 'motion-full-chain');
  assert.equal(stepEvents[0].properties.step_id, firstStep);
  assert.equal(stepEvents[0].properties.action, 'status_change');
  assert.equal(stepEvents[0].properties.step_status, 'done');
  tracking.close();
}, false));

test('P1-D: SuperAgentConversations emits super_agent_approval_result and super_agent_turn_result with safe error mapping', () => fixture(async store => {
  const { tracking, events } = fakeTracker();
  const service = new SuperAgentConversations(store, {
    tracking,
    resolveAgent: async () => null,
  });
  assert.equal(superAgentError(new Error('HTTP 401 unauthorized')), 'AUTH_ERROR');
  assert.equal(superAgentError(new Error('request timed out')), 'TIMEOUT');
  assert.equal(superAgentError(new Error('stopped'), true), 'ABORTED');

  assert.equal(
    validProperties(omEvents, 'super_agent_turn_result', {
      runtime_kind: 'local-direct',
      engine: 'codex',
      model_id: 'gpt-5.3-codex',
      permission_mode: 'on-request',
      intent: 'game',
      outcome: 'completed',
      duration_ms: 4200,
      tool_call_count: 5,
      approval_count: 1,
      artifact_count: 1,
      changed_file_count: 3,
      input_tokens: 12000,
      output_tokens: 2400,
    }),
    true,
  );
  // Vendor-path agent model IDs (e.g. anthropic/claude-sonnet-4.5) must pass the shared modelId rule
  assert.equal(
    validProperties(omEvents, 'super_agent_turn_result', {
      runtime_kind: 'local-direct',
      engine: 'claude',
      model_id: 'anthropic/claude-sonnet-4.5',
      permission_mode: 'auto',
      intent: 'coding',
      outcome: 'completed',
      duration_ms: 1500,
      tool_call_count: 2,
      approval_count: 0,
      artifact_count: 0,
    }),
    true,
  );
  assert.equal(
    validProperties(omEvents, 'super_agent_approval_result', {
      runtime_kind: 'local-bridge',
      approval_kind: 'generation',
      decision: 'approved',
      always_allow: false,
      wait_ms: 1850,
    }),
    true,
  );
  // Private/unregistered fields must be rejected
  assert.equal(
    validProperties(omEvents, 'super_agent_turn_result', {
      runtime_kind: 'local-direct',
      engine: 'codex',
      permission_mode: 'on-request',
      outcome: 'completed',
      duration_ms: 100,
      tool_call_count: 0,
      approval_count: 0,
      artifact_count: 0,
      prompt: 'secret prompt',
    }),
    false,
  );
  await service.close();
  tracking.close();
}, false));

test('P2-E: Codex LLM trace sampling is deterministic per device and always retains failed/error turns', () => {
  assert.equal(resolveCodexTraceSampleRate({ environment: {} }), 1);
  assert.equal(resolveCodexTraceSampleRate({ environment: { OPENMOTION_LLM_TRACE_SAMPLE_RATE: '0.2' } }), 0.2);
  assert.equal(resolveCodexTraceSampleRate({ environment: { OPENMOTION_LLM_TRACE_SAMPLE_RATE: 'invalid' } }), 1);
  assert.equal(resolveCodexTraceSampleRate({ sampleRate: -0.5 }), 0);
  assert.equal(resolveCodexTraceSampleRate({ sampleRate: 2.5 }), 1);

  // Error turns are always forced even at sampleRate=0
  assert.deepEqual(
    shouldSampleCodexTurn({ sampleKey: 'omd_device_1', sampleRate: 0, turnStatus: 'failed', hasToolFailure: false }),
    { include: true, reason: 'error_forced' },
  );
  assert.deepEqual(
    shouldSampleCodexTurn({ sampleKey: 'omd_device_1', sampleRate: 0, turnStatus: 'completed', hasToolFailure: true }),
    { include: true, reason: 'error_forced' },
  );

  // Deterministic distribution at 20% across 1000 devices
  let kept = 0;
  for (let i = 0; i < 1000; i++) {
    const first = shouldSampleCodexTurn({ sampleKey: `omd_dev_${i}`, sampleRate: 0.2, turnStatus: 'completed', hasToolFailure: false });
    const repeat = shouldSampleCodexTurn({ sampleKey: `omd_dev_${i}`, sampleRate: 0.2, turnStatus: 'completed', hasToolFailure: false });
    assert.deepEqual(first, repeat, 'sampling must be deterministic per device');
    if (first.include) kept += 1;
  }
  assert.ok(kept > 150 && kept < 250, `expected ~200 sampled devices at 20%, got ${kept}`);
});

test('Media tracking completeness: conservation funnel, failure_phase, http_status, commercial_gate vs download 403, cancel, resume, custom redaction, and modality gates', () => fixture(async store => {
  // 1) Error classification separates AMR commercial_gate vs BYOK billing, download/storage 403, timeout, upstream 5xx, invalid request, empty output
  const err402 = withErrorMeta(new Error('OpenDesign balance too low'), { status: 402, upstreamCode: 'insufficient_balance' });
  assert.equal(extractHttpStatus(err402), 402);
  assert.equal(extractUpstreamErrorCode(err402), 'insufficient_balance');
  assert.equal(mediaGenerationError(err402, 'submitting'), 'BALANCE_LOW');
  assert.equal(mediaGenerationErrorCategory('BALANCE_LOW', 'submitting', 'amr_opendesign'), 'commercial_gate');
  assert.equal(mediaGenerationErrorCategory('BALANCE_LOW', 'submitting', 'byok_builtin'), 'byok_billing');

  const errPlan = withErrorMeta(new Error('Your plan does not include this model'), { status: 403, upstreamCode: 'tier_model_not_entitled' });
  assert.equal(mediaGenerationError(errPlan, 'submitting'), 'PLAN_NOT_ENTITLED');
  assert.equal(mediaGenerationErrorCategory('PLAN_NOT_ENTITLED', 'submitting', 'amr_account'), 'commercial_gate');
  assert.equal(mediaGenerationErrorCategory('PLAN_NOT_ENTITLED', 'submitting', 'byok_builtin'), 'byok_billing');

  // Unknown upstream codes normalize to closed 'other'; Node errno values are never treated as upstream codes
  assert.equal(extractUpstreamErrorCode(withErrorMeta(new Error('x'), { upstreamCode: 'custom_secret_code_123' })), 'other');
  assert.equal(extractUpstreamErrorCode(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })), undefined);

  // Storage presigned PUT 403 must classify as UPLOAD_FAILED / network_download, NOT AUTH_REJECTED
  const errStorage403 = withErrorMeta(new Error('OpenDesign Cloud reference upload storage HTTP 403; the job was not submitted'), { status: 403, errorSource: 'storage' });
  assert.equal(mediaGenerationError(errStorage403, 'uploading'), 'UPLOAD_FAILED');
  assert.equal(mediaGenerationErrorCategory('UPLOAD_FAILED', 'uploading', 'amr_opendesign'), 'network_download');

  // Download-phase 403 must classify as DOWNLOAD_FAILED / network_download, NOT auth_credential
  const errDownload403 = withErrorMeta(new Error('Media download HTTP 403'), { status: 403, errorSource: 'download' });
  assert.equal(mediaGenerationError(errDownload403, 'downloading'), 'DOWNLOAD_FAILED');
  assert.equal(mediaGenerationErrorCategory('DOWNLOAD_FAILED', 'downloading', 'amr_opendesign'), 'network_download');

  // Timeouts take precedence over saving/remote_task phases and map to 'timeout' category
  assert.equal(mediaGenerationError(new Error('Atlas generation timeout'), 'remote_task'), 'TIMEOUT');
  assert.equal(mediaGenerationError(new Error('Generation timed out'), 'saving'), 'TIMEOUT');
  assert.equal(mediaGenerationErrorCategory('TIMEOUT', 'remote_task', 'byok_builtin'), 'timeout');

  const err502 = withErrorMeta(new Error('Provider HTTP 502'), { status: 502 });
  assert.equal(mediaGenerationError(err502, 'submitting'), 'UPSTREAM_5XX');
  assert.equal(mediaGenerationErrorCategory('UPSTREAM_5XX', 'submitting', 'amr_opendesign'), 'upstream_error');

  const err400 = withErrorMeta(new Error('Provider HTTP 400'), { status: 400, upstreamCode: 'invalid_request' });
  assert.equal(mediaGenerationError(err400, 'submitting'), 'INVALID_REQUEST');
  assert.equal(mediaGenerationErrorCategory('INVALID_REQUEST', 'submitting', 'amr_opendesign'), 'client_validation');

  assert.equal(mediaGenerationError(new Error('Provider returned no media'), 'decoding'), 'EMPTY_OUTPUT');
  assert.equal(mediaGenerationError(new Error('Provider did not return valid image media'), 'decoding'), 'INVALID_MEDIA');

  // Schema integer, capability allowlist drift, & studio isolation guards
  assert.deepEqual([...approvedCapabilityIds], defaultCapabilities.map(c => c.id));
  assert.equal(validField(omEvents.media_generation_result.fields.http_status, 402), true);
  assert.equal(validField(omEvents.media_generation_result.fields.http_status, 402.5), false);
  assert.equal(Object.hasOwn(studioEvents, 'media_generation_rejected'), false);
  assert.equal(Object.hasOwn(studioEvents, 'media_generation_replayed'), false);
  assert.equal(Object.hasOwn(studioEvents, 'media_generation_retry_started'), false);

  // 2) MCP tool & upgrade gate events admit modality
  assert.deepEqual(
    toolInputFields('openmotion_media_use', { action: 'generate', modality: 'video' }),
    { action: 'generate', modality: 'video' },
  );
  assert.deepEqual(
    toolResultFields('openmotion_job_manage', { action: 'status' }, { job: { modality: 'audio' } }),
    { modality: 'audio' },
  );
  assert.equal(validProperties(omEvents, 'upgrade_link_result', {
    entry_from: 'agent_media_upgrade_free',
    outcome: 'success',
    entry_id: crypto.randomUUID(),
    modality: 'video',
  }), true);

  // 3) End-to-end gateway funnel: requested = submitted + rejected + replayed; HTTP 402, download 403, remote_task, cancel, resume, custom redaction
  const { tracking, events } = fakeTracker();
  let mode: 'http402' | 'download403' | 'remote_fail' | 'flaky_poll_then_resume' | 'ok' = 'http402';
  let pollAttempts = 0;
  const gateway = new ModelGateway(store, {
    tracking,
    detect: async () => [],
    pollMs: 5,
    fetcher: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith('/images/generations') && init.method === 'POST') {
        if (mode === 'http402') return new Response(JSON.stringify({ error: { code: 'insufficient_balance' } }), { status: 402 });
        return Response.json({ task_id: `cloud_task_${mode}` });
      }
      if (target.includes('/images/tasks/cloud_task_remote_fail')) {
        return Response.json({ status: 'failed', error: { code: 'provider_error', retryable: false } });
      }
      if (target.includes('/images/tasks/cloud_task_download403')) {
        return Response.json({ status: 'succeeded', assets: [{ url: 'https://cdn.example/expired.png' }] });
      }
      if (target.includes('/images/tasks/cloud_task_flaky_poll_then_resume')) {
        pollAttempts++;
        if (pollAttempts <= 5) return new Response('gateway timeout', { status: 504 });
        return Response.json({ status: 'succeeded', assets: [{ url: 'https://cdn.example/recovered.png' }] });
      }
      return Response.json({ status: 'succeeded', assets: [{ url: 'https://cdn.example/ok.png' }] });
    },
    download: async (url) => {
      if (String(url).includes('expired.png')) {
        throw Object.assign(new Error('Media download HTTP 403'), { status: 403 });
      }
      return png1x1;
    },
  });

  // Pre-queue rejections: project not open + account signed out / unavailable model
  await assert.rejects(gateway.submit({
    modality: 'image',
    prompt: 'Missing open project',
  }, codexHost, { entrySurface: 'mcp_media_use' }), /Open a project/i);

  await assert.rejects(gateway.submit({
    modality: 'image',
    prompt: 'No provider configured yet',
    library: { title: 'Signed out' },
  }, codexHost, { entrySurface: 'mcp_media_use' }), /unavailable/i);

  // Configure opendesign key (AMR API Key channel)
  await gateway.configureProvider('opendesign', { apiKey: 'od-secret-key', baseUrl: 'https://amr-api.open-design.ai' });

  // Submit -> HTTP 402 on submitting phase (amr_opendesign)
  mode = 'http402';
  const job402 = await gateway.submit({
    modality: 'image',
    prompt: 'Test 402',
    model: 'opendesign:gpt-image-2',
    idempotencyKey: 'idem-402',
    library: { title: 'Test 402' },
  }, codexHost, { entrySurface: 'studio' });
  // Idempotent replay increments requested + replayed (not submitted, not rejected)
  const replayed = await gateway.submit({
    modality: 'image',
    prompt: 'Test 402',
    model: 'opendesign:gpt-image-2',
    idempotencyKey: 'idem-402',
    library: { title: 'Test 402' },
  }, codexHost, { entrySurface: 'studio' });
  assert.equal(replayed.id, job402.id);

  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(task => task.done));

  // Submit -> download 403, then resume to verify attempt_number=2 & previous_error_code/previous_failure_phase
  let allowDownloadRecovery = false;
  gateway.options.download = async (url) => {
    if (String(url).includes('expired.png') && !allowDownloadRecovery) {
      throw Object.assign(new Error('Media download HTTP 403'), { status: 403 });
    }
    return png1x1;
  };
  mode = 'download403';
  const jobDl403 = await gateway.submit({
    modality: 'image',
    prompt: 'Test download 403',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Test dl403' },
  }, codexHost, { entrySurface: 'mcp_assets_use' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(task => task.done));
  allowDownloadRecovery = true;
  await gateway.resume(jobDl403.id, 'resume-dl403');
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(task => task.done));

  // Submit -> remote task terminal failure with upstream error code
  mode = 'remote_fail';
  const jobRemoteFail = await gateway.submit({
    modality: 'image',
    prompt: 'Test remote fail',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Test remote fail' },
  }, codexHost, { entrySurface: 'mcp_capability_run' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(task => task.done));

  // Submit -> queued cancel with explicit cancel_source
  mode = 'ok';
  const jobCancelled = await gateway.submit({
    modality: 'image',
    prompt: 'Test cancel',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Test cancel' },
  }, codexHost, { entrySurface: 'studio' });
  await gateway.cancel(jobCancelled.id, { source: 'studio' });

  // Custom compatible provider: keeps http_status and route_channel=byok_custom, redacts model_provider, model_id & upstream_error_code
  const customProviderId = await gateway.connections.configure(null, {
    label: 'Secret Gateway',
    baseUrl: 'https://private-custom.example.com/v1',
    apiKey: 'secret-token-xyz',
    protocol: 'openai',
    enabled: true,
  });
  await gateway.connections.saveModel(customProviderId, {
    modelId: 'internal/private-v2',
    label: 'Private V2',
    kind: 'image',
    enabled: true,
  });
  const customFailGateway = new ModelGateway(store, {
    tracking,
    fetcher: async () => new Response('rate limited', { status: 429 }),
    pollMs: 5,
  });
  const customJob = await customFailGateway.submit({
    modality: 'image',
    prompt: 'Custom 429',
    model: `${customProviderId}:internal/private-v2`,
    library: { title: 'Custom' },
  }, undefined, { entrySurface: 'scenario' });
  await customFailGateway.tick();
  await Promise.all([...customFailGateway.active.values()].map(task => task.done));

  while (tracking.pending() > 0) await tracking.flush();

  const requested = events.filter(e => e.event === 'media_generation_requested');
  const submitted = events.filter(e => e.event === 'media_generation_submitted');
  const rejected = events.filter(e => e.event === 'media_generation_rejected');
  const replayedEvs = events.filter(e => e.event === 'media_generation_replayed');
  assert.equal(requested.length, submitted.length + rejected.length + replayedEvs.length, 'requested must equal submitted + rejected + replayed');

  // Verify rejection events
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].properties.rejection_reason, 'PROJECT_NOT_OPEN');
  assert.equal(rejected[0].properties.rejection_category, 'project_missing');
  assert.equal(rejected[1].properties.rejection_reason, 'ACCOUNT_SIGNED_OUT');
  assert.equal(rejected[1].properties.rejection_category, 'commercial_gate');
  assert.equal(rejected[1].properties.entry_surface, 'mcp_media_use');

  // Verify replay event
  assert.equal(replayedEvs.length, 1);
  assert.equal(replayedEvs[0].properties.job_id, job402.id);
  assert.equal(replayedEvs[0].properties.existing_job_state, 'queued');

  // Verify 402 result
  const res402 = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === job402.id);
  assert.equal(res402?.properties.route_channel, 'amr_opendesign');
  assert.equal(res402?.properties.entry_surface, 'studio');
  assert.equal(res402?.properties.failure_phase, 'submitting');
  assert.equal(res402?.properties.http_status, 402);
  assert.equal(res402?.properties.error_code, 'BALANCE_LOW');
  assert.equal(res402?.properties.error_category, 'commercial_gate');
  assert.equal(res402?.properties.has_remote_id, false);

  // Verify download 403 result & subsequent resume recovery
  const dlResults = events.filter(e => e.event === 'media_generation_result' && e.properties.job_id === jobDl403.id);
  assert.equal(dlResults.length, 2);
  const resDl403 = dlResults[0];
  assert.equal(resDl403?.properties.failure_phase, 'downloading');
  assert.equal(resDl403?.properties.http_status, 403);
  assert.equal(resDl403?.properties.error_code, 'DOWNLOAD_FAILED');
  assert.equal(resDl403?.properties.error_category, 'network_download');
  assert.equal(resDl403?.properties.has_remote_id, true);
  assert.equal(resDl403?.properties.is_resumable, true);
  const retryStarted = events.find(e => e.event === 'media_generation_retry_started' && e.properties.job_id === jobDl403.id);
  assert.equal(retryStarted?.properties.attempt_kind, 'resume');
  assert.equal(retryStarted?.properties.attempt_number, 2);
  assert.equal(retryStarted?.properties.previous_error_code, 'DOWNLOAD_FAILED');
  assert.equal(retryStarted?.properties.previous_failure_phase, 'downloading');
  const resDlRecovered = dlResults[1];
  assert.equal(resDlRecovered?.properties.job_state, 'completed');
  assert.equal(resDlRecovered?.properties.attempt_kind, 'resume');
  assert.equal(resDlRecovered?.properties.attempt_number, 2);
  assert.equal(resDlRecovered?.properties.attempt_id, retryStarted?.properties.attempt_id);
  assert.equal(resDlRecovered?.properties.previous_error_code, 'DOWNLOAD_FAILED');
  assert.equal(resDlRecovered?.properties.previous_failure_phase, 'downloading');

  // Verify remote terminal failure result
  const resRemote = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === jobRemoteFail.id);
  assert.equal(resRemote?.properties.failure_phase, 'remote_task');
  assert.equal(resRemote?.properties.remote_terminal, true);
  assert.equal(resRemote?.properties.upstream_error_code, 'provider_error');
  assert.equal(resRemote?.properties.error_code, 'REMOTE_FAILED');
  assert.equal(resRemote?.properties.error_category, 'upstream_error');
  assert.equal(resRemote?.properties.is_resumable, false);

  // Verify cancel result
  const resCancel = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === jobCancelled.id);
  assert.equal(resCancel?.properties.failure_phase, 'cancelled');
  assert.equal(resCancel?.properties.phase_before_cancel, 'queued');
  assert.equal(resCancel?.properties.cancel_source, 'studio');
  assert.equal(typeof resCancel?.properties.cancel_wait_ms, 'number');
  assert.equal(resCancel?.properties.error_category, 'user_cancelled');

  // Verify custom provider redaction & 429 classification
  const resCustom = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === customJob.id);
  assert.equal(resCustom?.properties.provider_kind, 'custom');
  assert.equal(resCustom?.properties.route_channel, 'byok_custom');
  assert.equal(resCustom?.properties.model_provider, undefined);
  assert.equal(resCustom?.properties.model_id, undefined);
  assert.equal(resCustom?.properties.upstream_error_code, undefined);
  assert.equal(resCustom?.properties.http_status, 429);
  assert.equal(resCustom?.properties.error_code, 'RATE_LIMITED');
  assert.equal(resCustom?.properties.error_category, 'rate_limit');
  assert.equal(resCustom?.properties.entry_surface, 'scenario');

  // Verify strict privacy and payload size cap (< 4096 bytes)
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /od-secret-key|secret-token-xyz|idem-402|private-v2|No provider configured/);
  for (const ev of events) {
    assert.ok(JSON.stringify(ev).length <= 4096, `event ${ev.event} exceeded 4096 byte limit`);
  }

  await gateway.close();
  await customFailGateway.close();
  tracking.close();
}, false));

test('Media tracking review regressions: storage PUT 403, Cloud entitlement 403, BYOK 402, unconfigured BYOK, cross-surface replay, upload/remote timing split, queued-resume cancel, running cancel, dead worker interrupt, resumableDownload status reset', () => fixture(async store => {
  const { tracking, events } = fakeTracker();
  let uploadBehavior: 'ok_slow' | 'put403' = 'put403';
  let submitBehavior: 'ok' | 'plan403' | 'empty403' | 'unknown403' | 'video_content403' | 'hang_poll' = 'ok';
  let resolveHangPoll!: () => void;
  const hangPollReached = new Promise<void>(resolve => { resolveHangPoll = resolve; });

  const gateway = new ModelGateway(store, {
    tracking,
    detect: async () => [],
    pollMs: 10,
    fetcher: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith('/api/v1/media/models?include_audio=true')) {
        return Response.json({
          models: [
            { model: 'gpt-image-2', kind: 'image', capabilities: { edits: true, max_input_images: 4 } },
            { model: 'seedance-2.0', kind: 'video', capabilities: { max_input_images: 1 } },
          ],
        });
      }
      if (target.endsWith('/uploads') && init.method === 'POST') {
        return Response.json({ asset_id: 'up_1', upload_url: 'https://storage.example/presigned-put' });
      }
      if (target === 'https://storage.example/presigned-put' && init.method === 'PUT') {
        if (uploadBehavior === 'put403') return new Response('forbidden', { status: 403 });
        await delay(35);
        return new Response(null, { status: 200 });
      }
      if (target.endsWith('/uploads/up_1/commit') && init.method === 'POST') {
        return Response.json({ status: 'ready' });
      }
      if (target.endsWith('/images/edits') && init.method === 'POST') {
        return Response.json({ task_id: 'task_edit_ok' });
      }
      if (target.endsWith('/images/generations') && init.method === 'POST') {
        if (submitBehavior === 'plan403') {
          return new Response(JSON.stringify({ error: { code: 'tier_model_not_entitled' } }), { status: 403 });
        }
        if (submitBehavior === 'empty403') {
          return new Response('', { status: 403 });
        }
        if (submitBehavior === 'unknown403') {
          return new Response(JSON.stringify({ error: { code: 'model_region_blocked_xyz' } }), { status: 403 });
        }
        if (submitBehavior === 'hang_poll') {
          return Response.json({ task_id: 'task_hang' });
        }
        return Response.json({ task_id: 'task_img_ok' });
      }
      if (target.endsWith('/videos/tasks') && init.method === 'POST') {
        return Response.json({ task_id: 'task_vid_403' });
      }
      if (target.includes('/videos/tasks/task_vid_403/content')) {
        return new Response('signed url expired', { status: 403 });
      }
      if (target.includes('/videos/tasks/task_vid_403')) {
        return Response.json({ status: 'succeeded' });
      }
      if (target.includes('/images/tasks/task_hang')) {
        resolveHangPoll();
        return Response.json({ status: 'running' });
      }
      return Response.json({ status: 'succeeded', assets: [{ url: 'https://cdn.example/out.png' }] });
    },
    download: async () => png1x1,
  });

  // 1) Explicit unconfigured BYOK model must reject as PROVIDER_NOT_CONFIGURED (NOT ACCOUNT_SIGNED_OUT)
  await assert.rejects(gateway.submit({
    modality: 'image',
    prompt: 'BYOK not configured',
    model: 'fal:fal-ai/flux/schnell',
    library: { title: 'Unconfigured BYOK' },
  }, codexHost, { entrySurface: 'mcp_media_use' }), /unavailable/i);

  // Sync OpenDesign Cloud models so supportsImageReference=true
  await gateway.configureProvider('opendesign', { apiKey: 'od-key-valid', baseUrl: 'https://amr-api.open-design.ai' });
  await gateway.listModels({ provider: 'opendesign', refresh: true });

  // Prepare a library reference image
  const refPath = path.join(store.directory, 'ref.png');
  await writeFile(refPath, png1x1);
  const { AssetLibrary } = await import('../gateway/asset-library.ts');
  const libAsset = await new AssetLibrary(store).importFile(refPath, { requestId: 'ref-1', name: 'Ref' });

  // 2) Presigned storage PUT 403: must keep storage error message, classify UPLOAD_FAILED / network_download, and NOT reject API key
  uploadBehavior = 'put403';
  const put403Job = await gateway.submit({
    modality: 'image',
    prompt: 'Edit with ref',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Put 403', references: [{ assetId: libAsset.id, versionId: libAsset.currentVersionId }] },
  }, undefined, { entrySurface: 'studio' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(t => t.done));
  const put403Done = await gateway.getJob(put403Job.id);
  assert.match(put403Done.error ?? '', /reference upload storage HTTP 403/i);
  assert.equal((await gateway.status()).providers.find(p => p.id === 'opendesign')?.verification, 'unverified');

  // 3) Upload vs Remote timing mutual exclusivity (upload ~35ms, remote ~10ms)
  uploadBehavior = 'ok_slow';
  const timingJob = await gateway.submit({
    modality: 'image',
    prompt: 'Edit timing check',
    model: 'opendesign:gpt-image-2',
    idempotencyKey: 'cross-surface-idem',
    library: { title: 'Timing', references: [{ assetId: libAsset.id, versionId: libAsset.currentVersionId }] },
  }, undefined, { entrySurface: 'studio' });
  // Cross-surface replay from mcp_media_use must attribute replayed event to mcp_media_use (not studio)
  const replayedJob = await gateway.submit({
    modality: 'image',
    prompt: 'Edit timing check',
    model: 'opendesign:gpt-image-2',
    idempotencyKey: 'cross-surface-idem',
    library: { title: 'Timing', references: [{ assetId: libAsset.id, versionId: libAsset.currentVersionId }] },
  }, codexHost, { entrySurface: 'mcp_media_use' });
  assert.equal(replayedJob.id, timingJob.id);
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(t => t.done));

  // 4) Cloud 403 tier_model_not_entitled, empty 403, and unknown-code 403 must NOT reject API key; unapproved capabilityId must map to 'other'
  submitBehavior = 'plan403';
  const plan403Job = await gateway.submit({
    modality: 'image',
    prompt: 'Entitlement test',
    model: 'opendesign:gpt-image-2',
    capabilityId: 'caller-secret-token-slug',
    library: { title: 'Plan 403' },
  }, undefined, { entrySurface: 'studio' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(t => t.done));
  assert.equal((await gateway.status()).providers.find(p => p.id === 'opendesign')?.verification, 'verified');

  submitBehavior = 'empty403';
  const empty403Job = await gateway.submit({
    modality: 'image',
    prompt: 'Empty 403 test',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Empty 403' },
  }, undefined, { entrySurface: 'studio' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(t => t.done));
  assert.equal((await gateway.status()).providers.find(p => p.id === 'opendesign')?.verification, 'verified');

  submitBehavior = 'unknown403';
  const unknown403Job = await gateway.submit({
    modality: 'image',
    prompt: 'Unknown 403 test',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Unknown 403' },
  }, undefined, { entrySurface: 'studio' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(t => t.done));
  assert.equal((await gateway.status()).providers.find(p => p.id === 'opendesign')?.verification, 'verified');

  // 5) Cloud video /content 403: DOWNLOAD_FAILED / network_download, captures video params, and must NOT reject API key
  submitBehavior = 'video_content403';
  const vidJob = await gateway.submit({
    modality: 'video',
    prompt: 'Video content 403',
    model: 'opendesign:seedance-2.0',
    parameters: { duration: 10, resolution: '1080p', ratio: '16:9', generate_audio: true },
    library: { title: 'Video 403' },
  }, undefined, { entrySurface: 'studio' });
  await gateway.tick();
  await Promise.all([...gateway.active.values()].map(t => t.done));
  assert.equal((await gateway.status()).providers.find(p => p.id === 'opendesign')?.verification, 'verified');

  // 6) Queued resume cancellation: must clear stale startedAt so queue_wait_ms is omitted and cancel_wait_ms uses attemptCreatedAt
  await delay(25);
  await gateway.resume(vidJob.id, 'resume-then-cancel');
  const resumedQueued = await gateway.getJob(vidJob.id);
  assert.equal(resumedQueued.startedAt, undefined);
  await gateway.cancel(vidJob.id, { source: 'mcp' });

  // 7) Running job cancellation captures non-queued phase_before_cancel and live remote_ms
  submitBehavior = 'hang_poll';
  const runCancelJob = await gateway.submit({
    modality: 'image',
    prompt: 'Cancel while running',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Run cancel' },
  }, undefined, { entrySurface: 'studio' });
  await gateway.tick();
  await hangPollReached;
  await gateway.cancel(runCancelJob.id, { source: 'studio' });
  await Promise.all([...gateway.active.values()].map(t => t.done));

  // 8) Dead worker interrupted reconciliation via tick() records last_active_phase and WORKER_INTERRUPTED
  submitBehavior = 'ok';
  const deadJob = await gateway.submit({
    modality: 'image',
    prompt: 'Dead worker test',
    model: 'opendesign:gpt-image-2',
    library: { title: 'Dead worker' },
  }, undefined, { entrySurface: 'studio' });
  const deadPath = path.join(gateway.root, 'jobs', `${deadJob.id}.json`);
  const storedDead = await gateway.getJob(deadJob.id);
  await writeFile(deadPath, JSON.stringify({ ...storedDead, state: 'running', phase: 'generating', startedAt: Date.now() - 50, workerPid: 2147483647 }));
  await gateway.tick();

  // 9) BYOK 402 classifies as byok_billing (NOT commercial_gate)
  const falGateway = new ModelGateway(store, {
    tracking,
    detect: async () => [],
    pollMs: 5,
    fetcher: async () => new Response(JSON.stringify({ error: { code: 'insufficient_balance' } }), { status: 402 }),
  });
  await falGateway.configureProvider('fal', { apiKey: 'fal-key' });
  const byok402Job = await falGateway.submit({
    modality: 'image',
    prompt: 'BYOK 402',
    model: 'fal:fal-ai/flux/schnell',
    library: { title: 'BYOK 402' },
  }, undefined, { entrySurface: 'studio' });
  await falGateway.tick();
  await Promise.all([...falGateway.active.values()].map(t => t.done));

  // 10) resumableDownload failing with 403 then stream error must NOT keep stale 403 status
  let dlAttempt = 0;
  const dlDir = path.join(store.directory, 'dl-status-reset');
  await import('node:fs/promises').then(fs => fs.mkdir(dlDir, { recursive: true }));
  await assert.rejects(
    resumableDownload(
      dlDir,
      async () => ({ assetId: 'a1', size: 128, mime: 'image/png', url: 'https://cdn.example/img.png' }),
      new AbortController().signal,
      async () => {},
      async () => {
        dlAttempt++;
        if (dlAttempt === 1) return new Response('forbidden', { status: 403 });
        throw new Error('socket hang up');
      },
      2,
    ),
    (err: unknown) => {
      assert.equal(extractHttpStatus(err), undefined, 'final stream error must not carry stale 403 from attempt 1');
      return true;
    },
  );

  while (tracking.pending() > 0) await tracking.flush();

  // Assert per-surface conservation for mcp_media_use (1 rejected + 1 replayed = 2 requested)
  const mcpReq = events.filter(e => e.event === 'media_generation_requested' && e.properties.entry_surface === 'mcp_media_use');
  const mcpSub = events.filter(e => e.event === 'media_generation_submitted' && e.properties.entry_surface === 'mcp_media_use');
  const mcpRej = events.filter(e => e.event === 'media_generation_rejected' && e.properties.entry_surface === 'mcp_media_use');
  const mcpRep = events.filter(e => e.event === 'media_generation_replayed' && e.properties.entry_surface === 'mcp_media_use');
  assert.equal(mcpReq.length, mcpSub.length + mcpRej.length + mcpRep.length);
  assert.equal(mcpRej[0]?.properties.rejection_reason, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(mcpRej[0]?.properties.rejection_category, 'provider_unavailable');
  assert.equal(mcpRep[0]?.properties.entry_surface, 'mcp_media_use');
  assert.equal(mcpRep[0]?.host_context?.host_agent, 'codex');

  // Assert storage PUT 403
  const put403Res = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === put403Job.id);
  assert.equal(put403Res?.properties.failure_phase, 'uploading');
  assert.equal(put403Res?.properties.http_status, 403);
  assert.equal(put403Res?.properties.error_code, 'UPLOAD_FAILED');
  assert.equal(put403Res?.properties.error_category, 'network_download');

  // Assert upload_ms and remote_ms are mutually exclusive (upload >= 25ms; upload + remote <= end_to_end + 10ms)
  const timingRes = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === timingJob.id);
  assert.equal(timingRes?.properties.job_state, 'completed');
  assert.ok((timingRes?.properties.upload_ms ?? 0) >= 25, `expected upload_ms >= 25, got ${timingRes?.properties.upload_ms}`);
  assert.ok((timingRes?.properties.remote_ms ?? 0) < (timingRes?.properties.upload_ms ?? 0) + 15 || (timingRes?.properties.upload_ms ?? 0) + (timingRes?.properties.remote_ms ?? 0) <= (timingRes?.properties.end_to_end_ms ?? 0) + 10);

  // Assert Cloud 403 entitlement, empty 403, unknown-code 403, and capability_id privacy mapping
  const plan403Sub = events.find(e => e.event === 'media_generation_submitted' && e.properties.job_id === plan403Job.id);
  const plan403Req = events.find(e => e.event === 'media_generation_requested' && e.properties.request_id === plan403Sub?.properties.request_id);
  assert.equal(plan403Req?.properties.capability_id, 'other');
  assert.equal(plan403Sub?.properties.capability_id, 'other');
  const plan403Res = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === plan403Job.id);
  assert.equal(plan403Res?.properties.http_status, 403);
  assert.equal(plan403Res?.properties.upstream_error_code, 'tier_model_not_entitled');
  assert.equal(plan403Res?.properties.error_code, 'PLAN_NOT_ENTITLED');
  assert.equal(plan403Res?.properties.error_category, 'commercial_gate');
  const empty403Res = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === empty403Job.id);
  assert.equal(empty403Res?.properties.http_status, 403);
  assert.equal(empty403Res?.properties.upstream_error_code, undefined);
  const unknown403Res = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === unknown403Job.id);
  assert.equal(unknown403Res?.properties.http_status, 403);
  assert.equal(unknown403Res?.properties.upstream_error_code, 'other');
  assert.doesNotMatch(JSON.stringify(events), /caller-secret-token-slug|model_region_blocked_xyz/);

  // Assert video /content 403 + video params + queued-resume cancel
  const vidResults = events.filter(e => e.event === 'media_generation_result' && e.properties.job_id === vidJob.id);
  assert.equal(vidResults.length, 2);
  assert.equal(vidResults[0]?.properties.failure_phase, 'downloading');
  assert.equal(vidResults[0]?.properties.error_code, 'DOWNLOAD_FAILED');
  assert.equal(vidResults[0]?.properties.requested_duration_sec, 10);
  assert.equal(vidResults[0]?.properties.requested_resolution, '1080p');
  assert.equal(vidResults[0]?.properties.requested_aspect_ratio, '16:9');
  assert.equal(vidResults[0]?.properties.requested_audio, true);
  assert.equal(vidResults[1]?.properties.job_state, 'cancelled');
  assert.equal(vidResults[1]?.properties.attempt_kind, 'resume');
  assert.equal(vidResults[1]?.properties.queue_wait_ms, undefined);
  assert.ok((vidResults[1]?.properties.cancel_wait_ms ?? 9999) < (vidResults[1]?.properties.end_to_end_ms ?? 0));

  // Assert running cancel captured non-queued phase and live remote_ms
  const runCancelRes = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === runCancelJob.id);
  assert.equal(runCancelRes?.properties.job_state, 'cancelled');
  assert.notEqual(runCancelRes?.properties.phase_before_cancel, 'queued');
  assert.equal(runCancelRes?.properties.last_active_phase, runCancelRes?.properties.phase_before_cancel);
  assert.equal(typeof runCancelRes?.properties.remote_ms, 'number');

  // Assert dead worker interrupted event
  const deadRes = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === deadJob.id);
  assert.equal(deadRes?.properties.failure_phase, 'interrupted');
  assert.equal(deadRes?.properties.last_active_phase, 'generating');
  assert.equal(deadRes?.properties.error_code, 'WORKER_INTERRUPTED');
  assert.equal(deadRes?.properties.error_category, 'client_interrupted');

  // Assert BYOK 402 -> byok_billing
  const byokRes = events.find(e => e.event === 'media_generation_result' && e.properties.job_id === byok402Job.id);
  assert.equal(byokRes?.properties.route_channel, 'byok_builtin');
  assert.equal(byokRes?.properties.http_status, 402);
  assert.equal(byokRes?.properties.error_code, 'BALANCE_LOW');
  assert.equal(byokRes?.properties.error_category, 'byok_billing');

  await gateway.close();
  await falGateway.close();
  tracking.close();
}, false));
