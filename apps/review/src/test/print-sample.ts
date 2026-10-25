/** Dev helper: print the review a sample PR would get (offline). `pnpm exec tsx src/test/print-sample.ts` */
import { createTestContext, job, seedInstallation } from './context';
import { setupHeadA, setupHeadB } from './fixtures';

const ctx = await createTestContext();
await seedInstallation(ctx);
setupHeadA(ctx.github);
await ctx.runtime.service.run(job());
setupHeadB(ctx.github);
await ctx.runtime.service.run(job({ trigger: 'synchronize' }));
for (const r of ctx.github.reviews) {
  console.log(`\n================ REVIEW ${r.id} on ${r.input.commitId} ================\n${r.input.body}`);
  for (const c of r.input.comments)
    console.log(`\n---- inline ${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line} ----\n${c.body}`);
}
await ctx.close();
