/** T3.3 测试夹具：假重判定 seam（coverage 可编程）。 */
import { createJsonBackend, openTdaDomain } from '@tda/kernel';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createIdentityService, type IdentityDeps, type IdentityRehearsalSeam, type IdentityService } from '../src/service.ts';
import { identityDomainSpec } from '../src/domain.ts';

export const NOW = 1_797_000_000_000;

export interface Fixture {
  readonly service: IdentityService;
  readonly domain: Awaited<ReturnType<typeof openTdaDomain>>;
  readonly judgeCalls: { readonly kind: string; readonly ref: string; readonly profile: string }[];
  readonly proposeCalls: { readonly kind: string }[];
  readonly setCoverage: (next: number) => void;
  readonly setVerdict: (next: 'pass' | 'fail') => void;
  readonly dispose: () => Promise<void>;
}

export async function setup(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tda-id-test-'));
  const backend = await createJsonBackend(dir);
  const domain = await openTdaDomain(identityDomainSpec, { backend });
  let coverage = 0.95;
  let verdict: 'pass' | 'fail' = 'pass';
  const judgeCalls: { kind: string; ref: string; profile: string }[] = [];
  const proposeCalls: { kind: string }[] = [];
  let proposeSeq = 0;
  const seam: IdentityRehearsalSeam = {
    async judge(component, judgeProfile) {
      judgeCalls.push({ kind: component.kind, ref: component.ref, profile: judgeProfile });
      return { verdict, rehearsalId: `reh-${judgeCalls.length}`, coverage };
    },
    async propose(component) {
      proposeCalls.push({ kind: component.kind });
      proposeSeq += 1;
      return `${component.kind === 'strategy' ? 'hc' : 'mp'}-new-${proposeSeq}`;
    },
  };
  const deps: IdentityDeps = {
    domain,
    session: { sessionId: 'sess-identity' as never, append: () => 1, flush() {} },
    rehearsal: seam,
    now: () => NOW,
  };
  const service = createIdentityService(deps);
  await service.initialize();
  return {
    service,
    domain,
    judgeCalls,
    proposeCalls,
    setCoverage: (next) => {
      coverage = next;
    },
    setVerdict: (next) => {
      verdict = next;
    },
    dispose: async () => {
      await domain.close();
      await backend.close();
      // [test-rm-bypass] detached 子进程清理
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    },
  };
}
