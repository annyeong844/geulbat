import assert from 'node:assert/strict';
import test from 'node:test';

import { FileAccessError } from '../files/file-domain-error.js';
import { resolveComputerFileToolPath } from './file-tool-root.js';

void test('relative file paths start from cwd but remain computer-root relative', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/computer',
        workingDirectory: 'workspace/writer/repo',
      },
      '../Downloads/xharness.txt',
    ),
    {
      root: 'computer',
      absoluteRoot: '/computer',
      path: 'workspace/writer/Downloads/xharness.txt',
    },
  );
});

void test('absolute file paths are admitted across the host filesystem', () => {
  const context = {
    computerFileRoot: '/computer',
    workingDirectory: 'workspace/writer/repo',
  };

  assert.deepEqual(
    resolveComputerFileToolPath(context, '/computer/Downloads/xharness.txt'),
    {
      root: 'computer',
      absoluteRoot: '/computer',
      path: 'Downloads/xharness.txt',
    },
  );
  assert.deepEqual(resolveComputerFileToolPath(context, '/private/notes.txt'), {
    root: 'computer',
    absoluteRoot: '/computer',
    path: '../private/notes.txt',
  });
});

void test('a global Computer scope admits an absolute path independently of cwd', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/',
        workingDirectory: 'tmp/unrelated-command-start',
      },
      '/home/user/Documents/note.md',
    ),
    {
      root: 'computer',
      absoluteRoot: '/',
      path: 'home/user/Documents/note.md',
    },
  );
});

void test('a local WSL UNC alias addresses the same global Computer path', (t) => {
  const previousDistroName = process.env.WSL_DISTRO_NAME;
  t.after(() => {
    if (previousDistroName === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = previousDistroName;
    }
  });
  process.env.WSL_DISTRO_NAME = 'Ubuntu';

  const context = {
    computerFileRoot: '/',
    workingDirectory: 'tmp/unrelated-command-start',
  };

  assert.deepEqual(
    resolveComputerFileToolPath(
      context,
      '\\\\wsl.localhost\\Ubuntu\\home\\user\\Documents\\note.md',
    ),
    {
      root: 'computer',
      absoluteRoot: '/',
      path: 'home/user/Documents/note.md',
    },
  );
  assert.deepEqual(
    resolveComputerFileToolPath(
      context,
      '\\\\wsl$\\ubuntu\\home\\user\\Documents\\note.md',
    ),
    {
      root: 'computer',
      absoluteRoot: '/',
      path: 'home/user/Documents/note.md',
    },
  );
});

void test('a local WSL UNC cwd remains usable for relative file paths', (t) => {
  const previousDistroName = process.env.WSL_DISTRO_NAME;
  t.after(() => {
    if (previousDistroName === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = previousDistroName;
    }
  });
  process.env.WSL_DISTRO_NAME = 'Ubuntu';

  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/',
        workingDirectory:
          '\\\\wsl.localhost\\Ubuntu\\home\\user\\workspaces\\geulbat',
      },
      'package.json',
    ),
    {
      root: 'computer',
      absoluteRoot: '/',
      path: 'home/user/workspaces/geulbat/package.json',
    },
  );
});

void test('a WSL UNC alias for another distro is not projected locally', (t) => {
  const previousDistroName = process.env.WSL_DISTRO_NAME;
  t.after(() => {
    if (previousDistroName === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = previousDistroName;
    }
  });
  process.env.WSL_DISTRO_NAME = 'Ubuntu';

  const resolved = resolveComputerFileToolPath(
    { computerFileRoot: '/' },
    '\\\\wsl.localhost\\Debian\\home\\writer\\note.md',
  );

  assert.equal(resolved.path, 'wsl.localhost/Debian/home/writer/note.md');
});

void test('a Windows Computer root preserves native UNC path semantics', (t) => {
  const previousDistroName = process.env.WSL_DISTRO_NAME;
  t.after(() => {
    if (previousDistroName === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = previousDistroName;
    }
  });
  process.env.WSL_DISTRO_NAME = 'Ubuntu';

  assert.deepEqual(
    resolveComputerFileToolPath(
      { computerFileRoot: 'C:\\' },
      '\\\\wsl.localhost\\Ubuntu\\home\\writer\\note.md',
    ),
    {
      root: 'computer',
      absoluteRoot: 'C:\\',
      path: '//wsl.localhost/Ubuntu/home/writer/note.md',
    },
  );
});

void test('file paths fail closed when ComputerFileScope is unavailable', () => {
  assert.throws(
    () => resolveComputerFileToolPath({ workingDirectory: '' }, 'notes.txt'),
    (error: unknown) =>
      error instanceof FileAccessError && error.code === 'access_denied',
  );
});

void test('a current directory outside the coordinate base remains usable', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/computer',
        workingDirectory: '../outside',
      },
      'notes.txt',
    ),
    {
      root: 'computer',
      absoluteRoot: '/computer',
      path: '../outside/notes.txt',
    },
  );
});

void test('Windows file paths use the same ComputerFileScope contract', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: 'D:\\workspace',
        workingDirectory: 'repo',
      },
      '..\\Downloads\\xharness.txt',
    ),
    {
      root: 'computer',
      absoluteRoot: 'D:\\workspace',
      path: 'Downloads/xharness.txt',
    },
  );
});

void test('Windows absolute paths may select another drive', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: 'C:\\',
        workingDirectory: 'Users\\Writer',
      },
      'D:\\Archive\\novel.md',
    ),
    {
      root: 'computer',
      absoluteRoot: 'C:\\',
      path: 'D:/Archive/novel.md',
    },
  );
});
