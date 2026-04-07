// Test: traer Windows Terminal al frente desde Node.js
// Simula exactamente lo que hará Electron al hacer clic en un chip

const { execSync } = require('child_process');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr hwnd, int cmd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)');
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr hwnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint flags)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(intptr hwnd, uint* pid)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint attach, uint to, bool fAttach)');
const GetCurrentThreadId = koffi.load('kernel32.dll').func('uint __stdcall GetCurrentThreadId()');

const SW_RESTORE = 9;
const SW_MINIMIZE = 6;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_SHOWWINDOW = 0x0040;

// Get WT handle
const handle = execSync(
  'powershell.exe -NoProfile -Command "(Get-Process WindowsTerminal -EA SilentlyContinue | Select -First 1).MainWindowHandle"',
  { encoding: 'utf-8' }
).trim();
const hwnd = parseInt(handle);
console.log(`WT handle: ${hwnd}`);

// Step 1: Minimize WT to simulate user's scenario
console.log('\n--- Minimizing WT ---');
ShowWindow(hwnd, SW_MINIMIZE);

// Wait 2 seconds
console.log('Waiting 2s...');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);

// Check: WT should be minimized
console.log('IsIconic (minimized):', IsIconic(hwnd));
console.log('Current foreground:', GetForegroundWindow());

// --- METHOD 1: Simple SetForegroundWindow ---
console.log('\n--- Method 1: SetForegroundWindow ---');
if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
let r = SetForegroundWindow(hwnd);
console.log('SetForegroundWindow result:', r);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
let fg = GetForegroundWindow();
console.log('Foreground after:', fg, 'Match:', fg === hwnd);

if (fg !== hwnd) {
  // Minimize again for next test
  ShowWindow(hwnd, SW_MINIMIZE);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

  // --- METHOD 2: AttachThreadInput + SetForegroundWindow ---
  console.log('\n--- Method 2: AttachThreadInput ---');
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);

  const fgWnd = GetForegroundWindow();
  const pidOut = [0];
  const fgThread = GetWindowThreadProcessId(fgWnd, pidOut);
  const myThread = GetCurrentThreadId();

  console.log('FG thread:', fgThread, 'My thread:', myThread);
  let attached = AttachThreadInput(myThread, fgThread, true);
  console.log('Attached:', attached);

  BringWindowToTop(hwnd);
  r = SetForegroundWindow(hwnd);
  console.log('SetForegroundWindow result:', r);

  AttachThreadInput(myThread, fgThread, false);

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  fg = GetForegroundWindow();
  console.log('Foreground after:', fg, 'Match:', fg === hwnd);
}

if (fg !== hwnd) {
  // Minimize again
  ShowWindow(hwnd, SW_MINIMIZE);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

  // --- METHOD 3: SetWindowPos TOPMOST trick ---
  console.log('\n--- Method 3: SetWindowPos TOPMOST ---');
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);

  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  SetForegroundWindow(hwnd);

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  fg = GetForegroundWindow();
  console.log('Foreground after:', fg, 'Match:', fg === hwnd);
}

if (fg !== hwnd) {
  ShowWindow(hwnd, SW_MINIMIZE);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);

  // --- METHOD 4: All combined ---
  console.log('\n--- Method 4: Everything combined ---');
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);

  const fgWnd2 = GetForegroundWindow();
  const pidOut2 = [0];
  const fgThread2 = GetWindowThreadProcessId(fgWnd2, pidOut2);
  const myThread2 = GetCurrentThreadId();
  AttachThreadInput(myThread2, fgThread2, true);

  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);

  AttachThreadInput(myThread2, fgThread2, false);

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  fg = GetForegroundWindow();
  console.log('Foreground after:', fg, 'Match:', fg === hwnd);
}

console.log('\n--- FINAL RESULT ---');
fg = GetForegroundWindow();
console.log('WT is foreground:', fg === hwnd);
