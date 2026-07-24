import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const attendance = await readFile(new URL('../src/AttendanceModule.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const version = await readFile(new URL('../version.json', import.meta.url), 'utf8');
const publicVersion = await readFile(new URL('../public/version.json', import.meta.url), 'utf8');

test('attendance enabled control uses a compact accessible switch', () => {
  assert.match(attendance, /className="attendanceToggleLabel"/);
  assert.match(attendance, /role="switch"/);
  assert.doesNotMatch(attendance, /className="toggleLabel"/);
  assert.match(styles, /\.attendanceToggleLabel[\s\S]*justify-self: end/);
  assert.match(styles, /\.storeAttendanceForm \.attendanceToggleLabel input[\s\S]*width: 46px/);
});

test('attendance switch remains aligned on mobile without overflowing', () => {
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.attendanceToggleLabel \{ width: 100%; justify-self: stretch; justify-content: space-between/);
});

test('Kakao map uses the Vite production environment variable', () => {
  assert.match(attendance, /import\.meta\.env\.VITE_KAKAO_MAP_APP_KEY/);
  assert.match(attendance, /396bcfcbdd813d5541db7cae2e0c6fbe/);
  assert.match(attendance, /dapi\.kakao\.com\/v2\/maps\/sdk\.js/);
});

test('all visible version files are V29.66', () => {
  assert.match(version, /V29\.66/);
  assert.match(publicVersion, /V29\.66/);
});

