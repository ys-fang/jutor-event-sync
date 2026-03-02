import { initEventSync, type EventSyncInstance } from '@jutor-event/sync';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDCluZGDwmr1EusTUDzuqz7hU9_q6YxQf4',
  authDomain: 'jutor-event.firebaseapp.com',
  projectId: 'jutor-event',
  storageBucket: 'jutor-event.firebasestorage.app',
  messagingSenderId: '279251916503',
  appId: '1:279251916503:web:54c7dc2954bb0c0a820292',
};

const MINT_TOKEN_URL =
  'https://speech-token-server-t26idchpnq-de.a.run.app/api/event/mint-token';

const $ = (id: string) => document.getElementById(id)!;

function log(msg: string) {
  const el = $('sync-log');
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${msg}\n${el.textContent}`;
}

async function main() {
  let sync: EventSyncInstance | null = null;

  try {
    sync = await initEventSync({
      appId: 'mock-test',
      localStoragePrefix: 'mock_',
      mintTokenUrl: MINT_TOKEN_URL,
      firebaseConfig: FIREBASE_CONFIG,
    });
  } catch (err: any) {
    $('auth-info').textContent = `Sync init failed: ${err.message}`;
    log(`Init error: ${err.message}`);
  }

  if (sync?.isLoggedIn) {
    const u = sync.user!;
    $('auth-info').innerHTML = [
      `<strong>Logged in</strong>`,
      `UID: <code>${u.uid}</code>`,
      `Name: ${u.userName}`,
      `Grade: ${u.grade || 'N/A'} / Class: ${u.class || 'N/A'}`,
      `School: ${u.schoolName || 'N/A'}`,
    ].join('<br/>');
    log(`Authenticated as ${u.userName} (${u.uid})`);

    ($('sync-now') as HTMLButtonElement).disabled = false;
    ($('sync-destroy') as HTMLButtonElement).disabled = false;
  } else {
    $('auth-info').innerHTML =
      `Not logged in to Jutor. <a href="#" id="login-link">Login</a>`;
    $('login-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      sync?.redirectToLogin();
    });
    log('No Jutor session detected');
  }

  $('ls-write').addEventListener('click', () => {
    const key = ($('ls-key') as HTMLInputElement).value;
    const value = ($('ls-value') as HTMLInputElement).value;
    localStorage.setItem(key, value);
    $('ls-output').textContent = `Written: ${key} = ${value}`;
    log(`localStorage.setItem("${key}", ...)`);
  });

  $('ls-read').addEventListener('click', () => {
    const key = ($('ls-key') as HTMLInputElement).value;
    const value = localStorage.getItem(key);
    $('ls-output').textContent = `Read: ${key} = ${value ?? '(null)'}`;
    log(`localStorage.getItem("${key}") = ${value ?? 'null'}`);
  });

  $('sync-now').addEventListener('click', async () => {
    if (!sync?.isLoggedIn) return;
    log('Syncing to Firestore...');
    try {
      await sync.syncNow();
      log('Sync complete');
      $('fs-output').textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
    } catch (err: any) {
      log(`Sync failed: ${err.message}`);
    }
  });

  $('sync-destroy').addEventListener('click', () => {
    sync?.destroy();
    log('Sync destroyed (timers stopped)');
    ($('sync-now') as HTMLButtonElement).disabled = true;
    ($('sync-destroy') as HTMLButtonElement).disabled = true;
  });
}

main();
