import { describe, expect, test } from 'bun:test';
import { normalizePermissionProfiles, permissionModes, threadPolicyFor, turnPolicyFor } from '../../public/composer-controls.js';

describe('shared composer permission boundaries', () => {
  test('configuration mode omits permission overrides at both protocol boundaries', () => {
    expect(threadPolicyFor(permissionModes.config)).toEqual({});
    expect(turnPolicyFor(permissionModes.config, '/project')).toEqual({});
  });

  test('native profiles never acquire legacy sandbox overrides', () => {
    const profile = { kind: 'profile', profileId: 'project-review' };
    expect(threadPolicyFor(profile)).toEqual({ permissions: 'project-review' });
    expect(turnPolicyFor(profile, '/project')).toEqual({ permissions: 'project-review', approvalPolicy: null, approvalsReviewer: null });
  });

  test('approval mode bounds writable roots and full access is explicit', () => {
    const policy = turnPolicyFor(permissionModes.default, '/project');
    expect(policy.approvalPolicy).toBe('on-request');
    expect(policy.sandboxPolicy.writableRoots).toEqual(['/project']);
    expect(policy.sandboxPolicy.networkAccess).toBe(false);
    expect(turnPolicyFor(permissionModes['full-access'], '/project')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  });

  test('profile lists reject reserved and duplicate IDs while keeping managed denial', () => {
    expect(normalizePermissionProfiles([
      { id: ' CONFIG ' }, { id: ':internal' }, { id: 'custom' }, { id: '' }, null,
      { id: ' review ', allowed: false, description: 'Managed' }, { id: 'REVIEW' },
      { id: 'work', description: 123 },
    ])).toEqual([{ id: 'review', allowed: false, description: 'Managed' }, { id: 'work', allowed: true, description: '' }]);
    expect(normalizePermissionProfiles(null)).toEqual([]);
  });
});
