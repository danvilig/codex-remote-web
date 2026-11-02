import { test, expect } from 'bun:test';
import { validatePullRequest, requiredSections, requiredDeclarations } from '../../scripts/pr-policy.ts';

function fixture() {
  const repository = { full_name: 'example/codex-remote-web' };
  return { title: 'ci(workflow): establish protected PR development', base: { ref: 'develop', repo: repository }, head: { ref: 'codex/git-workflow', repo: repository }, body: requiredSections.map(section => `## ${section}\n\nConcrete evidence for ${section}; checks and limitations are explained.`).join('\n\n') + '\n\n## Checklist\n\n' + requiredDeclarations.map(value => `- [x] ${value}`).join('\n') };
}
test('accepts an evidenced topic PR and rejects an empty commented template or false declarations', () => {
  const pr=fixture();expect(validatePullRequest(pr)).toEqual([]);
  pr.body=requiredSections.map(section=>`## ${section}\n<!-- TODO: explain everything here -->`).join('\n');
  expect(validatePullRequest(pr).length).toBe(8);
  const unchecked=fixture();unchecked.body=unchecked.body.replaceAll('- [x]','- [ ]');expect(validatePullRequest(unchecked).length).toBe(3);
  const placeholder=fixture();placeholder.body=placeholder.body.replace('Concrete evidence for AI assistance; checks and limitations are explained.','N/A');expect(validatePullRequest(placeholder)).toContain('Complete the AI assistance section with concrete evidence or an explained N/A.');
});
test('rejects direct feature promotion, cross-repository promotion and malformed titles', () => {
  const pr=fixture();pr.base.ref='main';expect(validatePullRequest(pr).length).toBe(1);
  pr.head.ref='develop';expect(validatePullRequest(pr)).toEqual([]);
  pr.head.repo={full_name:'contributor/fork'};expect(validatePullRequest(pr).length).toBe(1);
  pr.base.ref='develop';pr.head.ref='fix/auth-boundary';expect(validatePullRequest(pr)).toEqual([]);
  pr.title='quick update';expect(validatePullRequest(pr).length).toBe(1);
});
test('supports release stabilization and back-merges, not new release features', () => {
  const pr=fixture();pr.base.ref='release/0.2.0';pr.head.ref='fix/packaging';expect(validatePullRequest(pr)).toEqual([]);
  pr.head.ref='feat/new-feature';expect(validatePullRequest(pr).length).toBe(1);
  pr.head.ref='main';expect(validatePullRequest(pr)).toEqual([]);
  pr.base.ref='develop';expect(validatePullRequest(pr)).toEqual([]);
  pr.base.ref='unknown';expect(validatePullRequest(pr).length).toBe(1);
});
