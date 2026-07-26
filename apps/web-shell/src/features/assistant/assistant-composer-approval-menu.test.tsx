import test from 'node:test';
import assert from 'node:assert/strict';
import { useState, type ComponentProps } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AssistantComposerApprovalMenu } from './assistant-composer-approval-menu.js';
import {
  ComposerMenuButton,
  MenuBackRow,
  MenuNavRow,
  MenuOptionRow,
} from './composer-menu-rows.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

type ApprovalMenuHarnessProps = Omit<
  ComponentProps<typeof AssistantComposerApprovalMenu>,
  'active' | 'onToggle' | 'onClose'
>;

function ApprovalMenuHarness(props: ApprovalMenuHarnessProps) {
  const [active, setActive] = useState(false);
  return (
    <AssistantComposerApprovalMenu
      {...props}
      active={active}
      onToggle={() => setActive((current) => !current)}
      onClose={() => setActive(false)}
    />
  );
}

function findApprovalMenu(renderer: ReactTestRenderer) {
  const menu = renderer.root
    .findAllByType(ComposerMenuButton)
    .find((node) => node.props.title === '승인 방식');
  assert.ok(menu);
  return menu;
}

void test('the planning settings owner applies depth and presentation only after the final choice', async () => {
  const permissionModeChanges: Array<'basic' | 'full_access'> = [];
  const planModeChanges: boolean[] = [];
  const planIntensityChanges: Array<'quiet' | 'visual'> = [];
  const planDepthChanges: Array<'standard' | 'deep'> = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <ApprovalMenuHarness
        permissionMode="full_access"
        planModeRequested={false}
        planModeIntensity="quiet"
        planModeDepth="standard"
        onPermissionModeChange={(mode) => {
          permissionModeChanges.push(mode);
        }}
        onPlanModeRequestedChange={(next) => planModeChanges.push(next)}
        onPlanModeIntensityChange={(next) => planIntensityChanges.push(next)}
        onPlanModeDepthChange={(next) => planDepthChanges.push(next)}
      />,
    );
  });

  await act(async () => findApprovalMenu(renderer).props.onToggle());
  const planNav = renderer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '계획 모드');
  assert.ok(planNav);
  assert.equal(planNav.props.value, '꺼짐');

  await act(async () => planNav.props.onClick());
  assert.equal(renderer.root.findByType(MenuBackRow).props.label, '조사 깊이');
  const deep = renderer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === '심층');
  assert.ok(deep);
  await act(async () => deep.props.onClick());

  assert.deepEqual(planModeChanges, []);
  assert.deepEqual(planDepthChanges, []);
  assert.equal(renderer.root.findByType(MenuBackRow).props.label, '표현 방식');
  const visual = renderer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === '시각');
  assert.ok(visual);
  await act(async () => visual.props.onClick());

  assert.deepEqual(planModeChanges, [true]);
  assert.deepEqual(planIntensityChanges, ['visual']);
  assert.deepEqual(planDepthChanges, ['deep']);
  assert.deepEqual(permissionModeChanges, []);
  assert.equal(renderer.root.findAllByProps({ role: 'menu' }).length, 0);

  await act(async () => renderer.unmount());
});

void test('choosing a permission mode turns planning off before dispatching the permission change', async () => {
  const transitions: string[] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <ApprovalMenuHarness
        permissionMode="basic"
        planModeRequested
        planModeIntensity="visual"
        planModeDepth="standard"
        onPermissionModeChange={(mode) => {
          transitions.push(`permission:${mode}`);
        }}
        onPlanModeRequestedChange={(next) => transitions.push(`plan:${next}`)}
        onPlanModeIntensityChange={() => {}}
        onPlanModeDepthChange={() => {}}
      />,
    );
  });

  const approvalMenu = findApprovalMenu(renderer);
  assert.match(approvalMenu.props.label, /일반·시각/);
  await act(async () => approvalMenu.props.onToggle());
  const manual = renderer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === '수동 승인');
  assert.ok(manual);
  await act(async () => manual.props.onClick());

  assert.deepEqual(transitions, ['plan:false', 'permission:basic']);
  assert.equal(renderer.root.findAllByProps({ role: 'menu' }).length, 0);

  await act(async () => renderer.unmount());
});

void test('closing and reopening the menu discards an uncommitted planning depth', async () => {
  const planChanges: string[] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <ApprovalMenuHarness
        permissionMode="basic"
        planModeRequested={false}
        planModeIntensity="quiet"
        planModeDepth="standard"
        onPermissionModeChange={() => {}}
        onPlanModeRequestedChange={(next) => planChanges.push(`plan:${next}`)}
        onPlanModeIntensityChange={(next) =>
          planChanges.push(`intensity:${next}`)
        }
        onPlanModeDepthChange={(next) => planChanges.push(`depth:${next}`)}
      />,
    );
  });

  await act(async () => findApprovalMenu(renderer).props.onToggle());
  const planNav = renderer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '계획 모드');
  assert.ok(planNav);
  await act(async () => planNav.props.onClick());
  const deep = renderer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === '심층');
  assert.ok(deep);
  await act(async () => deep.props.onClick());

  await act(async () => findApprovalMenu(renderer).props.onToggle());
  await act(async () => findApprovalMenu(renderer).props.onToggle());
  const reopenedPlanNav = renderer.root
    .findAllByType(MenuNavRow)
    .find((row) => row.props.label === '계획 모드');
  assert.ok(reopenedPlanNav);
  await act(async () => reopenedPlanNav.props.onClick());
  const standard = renderer.root
    .findAllByType(MenuOptionRow)
    .find((row) => row.props.title === '일반');
  assert.ok(standard);
  assert.equal(standard.props.checked, true);
  assert.deepEqual(planChanges, []);

  await act(async () => renderer.unmount());
});
