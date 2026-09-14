import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { paginateDocx } from './paginateDocx.ts';

void test('DOCX pagination preserves text, inline markup, tables and explicit pages', async (t) => {
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave'];
  const executable = (
    await Promise.all(
      candidates.map(async (path) => {
        try {
          await access(path);
          return path;
        } catch {
          return null;
        }
      }),
    )
  ).find(Boolean);
  if (!executable) {
    return t.skip('A Chromium browser is required for layout assertions.');
  }
  const profile = await mkdtemp(join(tmpdir(), 'adamant-docx-test-'));
  const browser = spawn(executable, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ]);
  t.after(async () => {
    browser.kill();
    await new Promise((resolve) => browser.once('exit', resolve));
    await rm(profile, { recursive: true, force: true });
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 15000);
    browser.once('error', reject);
    browser.stderr.on('data', (data: Buffer) => {
      output += data.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const url = new URL(endpoint);
  const tabs = (await (await fetch(`http://${url.host}/json`)).json()) as {
    webSocketDebuggerUrl: string;
  }[];
  const socket = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  t.after(() => socket.close());
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
      document.body.innerHTML = '<style>section.docx {box-sizing:border-box;width:600px;min-height:700px;padding:50px;display:flex;flex-direction:column;margin-bottom:24px;background:white} article {margin-bottom:auto} p {margin:0;font:16px/24px serif} td {height:32px} body {background:#ddd}</style>';
      const page = document.createElement('section'); page.className = 'docx';
      const article = document.createElement('article'); page.append(article); document.body.append(page);
      article.innerHTML = '<p><b>' + 'Long paragraph with formatting. '.repeat(300) + '</b></p>' + '<p>Another paragraph.</p>'.repeat(60) + '<table><tbody>' + Array.from({length:50}, (_, i) => '<tr><td>Row ' + i + '</td></tr>').join('') + '</tbody></table>';
      const explicit = page.cloneNode(false); explicit.innerHTML = '<article><p>Explicit final page</p></article>'; page.after(explicit);
      const before = document.body.textContent;
      (${paginateDocx.toString()})(document);
      const pages = [...document.querySelectorAll('section.docx')];
      return {
        preserved: document.body.textContent === before,
        pages: pages.length,
        heights: pages.map(page => page.getBoundingClientRect().height),
        paragraphsFormatted: [...document.querySelectorAll('p')].filter(p => p.textContent.includes('Long paragraph')).every(p => p.querySelector('b')),
        rows: document.querySelectorAll('tr').length,
        last: pages.at(-1).textContent
      };
    })()`,
        returnByValue: true,
      },
    }),
  );
  const response = await new Promise<string>((resolve) =>
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }),
  );
  const result = JSON.parse(response).result;
  assert.equal(result.exceptionDetails, undefined);
  const value = result.result.value;
  assert.equal(value.preserved, true);
  assert.ok(value.pages > 5);
  assert.ok(
    value.heights.every((height: number) => height <= 701),
    JSON.stringify(value.heights),
  );
  assert.equal(value.paragraphsFormatted, true);
  assert.equal(value.rows, 50);
  assert.equal(value.last, 'Explicit final page');
});
