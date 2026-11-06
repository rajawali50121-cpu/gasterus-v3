import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const shell = readFileSync(new URL('../../admin/public/admin-shell.js', import.meta.url), 'utf8');

test('admin shell safely activates R6.94 when loaded from the document head', () => {
  let readyListener;
  let stylesheet;
  const classNames = [];
  const document = {
    body: null,
    head: { appendChild: link => { stylesheet = link; } },
    createElement: () => ({}),
    addEventListener: (event, listener, options) => {
      assert.equal(event, 'DOMContentLoaded');
      assert.equal(options.once, true);
      readyListener = listener;
    }
  };

  vm.runInNewContext(shell, {
    window: {},
    document,
    setInterval() {}
  });

  assert.equal(stylesheet.rel, 'stylesheet');
  assert.equal(stylesheet.href, 'enterprise-ui-r6940.css?v=r6940-enterprise-control');
  assert.equal(typeof readyListener, 'function');
  document.body = { classList: { add: name => classNames.push(name) } };
  readyListener();
  assert.deepEqual(classNames, ['enterprise-r6940']);
});
