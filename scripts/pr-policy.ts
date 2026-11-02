import { readFile } from 'node:fs/promises';

export const requiredSections = ['Summary', 'Changes', 'Verification', 'Risk and rollback', 'AI assistance'] as const;
export const requiredDeclarations = [
  'No secrets, private data or proprietary assets included.',
  'Reported checks were actually run; skipped checks have reasons.',
  'A maintainer will review and merge; AI output is not approval.',
] as const;

// PR text is untrusted data. Never interpolate it into a shell or print its
// contents in workflow commands. This checks format, not truth or correctness.
export function validatePullRequest(pr: any): string[] {
  const errors: string[] = [];
  if (typeof pr?.title !== 'string' || pr.title.length > 100 || !/^(?:feat|fix|docs|test|refactor|perf|build|ci|chore|revert|release)(?:\([a-zA-Z0-9_./-]+\))?!?:\s+\S.+$/.test(pr.title)) errors.push('Use a conventional title of at most 100 characters: type(scope): description.');
  const base = pr?.base?.ref || '', head = pr?.head?.ref || '';
  const sameRepository = typeof pr?.base?.repo?.full_name === 'string' && pr.base.repo.full_name === pr?.head?.repo?.full_name;
  const topic = /^(?:codex|feat|fix|docs|chore|hotfix)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
  const release = /^release\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (base === 'main') {
    if (!sameRepository || !(head === 'develop' || release.test(head) || /^hotfix\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(head))) errors.push('main accepts reviewed same-repository develop, release/<version> or hotfix/<topic> promotions only.');
  } else if (base === 'develop') {
    if (!(topic.test(head) || (sameRepository && (head === 'main' || release.test(head))))) errors.push('develop accepts topic branches, or same-repository main/release back-merges.');
  } else if (release.test(base)) {
    if (!/^(?:codex|fix|docs|chore|hotfix)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(head) && !(sameRepository && head === 'main')) errors.push('release branches accept stabilization branches or a same-repository main back-merge.');
  } else errors.push('PR target must be main, develop or release/<version>.');

  const body = typeof pr?.body === 'string' ? pr.body.replace(/<!--[\s\S]*?-->/g, '') : '';
  const sections = new Map<string, string>();
  const headings = [...body.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    sections.set(heading[1].trim(), body.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? body.length).trim());
  }
  for (const name of requiredSections) {
    const content = sections.get(name) || '';
    if (content.length < 12 || /^(?:n\/?a|none|todo|tbd|待补充|无|不适用)[.!。\s]*$/i.test(content)) errors.push(`Complete the ${name} section with concrete evidence or an explained N/A.`);
  }
  const checked = new Set([...body.matchAll(/^\s*- \[[xX]\] ([^\r\n]+)\r?$/gm)].map(match => match[1].trim()));
  for (const declaration of requiredDeclarations) if (!checked.has(declaration)) errors.push(`Confirm the required declaration: ${declaration}`);
  return errors;
}

if (import.meta.main) {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(await readFile(path, 'utf8'));
  const errors = validatePullRequest(event.pull_request);
  if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
  else console.log('PR structure and branch routing passed. Maintainer review is still required.');
}
