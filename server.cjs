// backend/server.cjs
// Express server to automate web push notifications on number update

const express = require('express');
const webpush = require('web-push');
const admin = require('firebase-admin');
const { getDatabase } = require('firebase-admin/database');
const cors = require('cors');

// --- CONFIG ---
const PORT = process.env.PORT || 3000;
// Update this to match your Firebase project database URL
const DB_URL = process.env.FIREBASE_DB_URL || 'https://new-satta-app-default-rtdb.firebaseio.com/';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

let SERVICE_ACCOUNT;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (error) {
    console.error('[Config] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON.');
    throw error;
  }
} else {
  try {
    SERVICE_ACCOUNT = require('./serviceAccountKey.json');
    console.warn('[Config] Loaded serviceAccountKey.json from disk. For production, supply FIREBASE_SERVICE_ACCOUNT env.');
  } catch (error) {
    console.error('[Config] No Firebase service account credentials found.');
    throw error;
  }
}

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[Config] Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY environment variables.');
  throw new Error('VAPID keys are required. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables.');
}

// --- INIT ---
admin.initializeApp({
  credential: admin.credential.cert(SERVICE_ACCOUNT),
  databaseURL: DB_URL,
});
const db = getDatabase();

webpush.setVapidDetails('mailto:your-email@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
app.use(cors());

// --- LISTEN FOR NUMBER UPDATES ---
const sattanameeRef = db.ref('sattanamee');

// Track last sent notifications to avoid duplicates
const lastSentNotifications = new Map(); // Map<`${sattaname}_${date}_${number}`, timestamp>

// Helper to check if we should send notification (avoid duplicates within 5 seconds)
function shouldSendNotification(sattaname, date, number) {
  const key = `${sattaname}_${date}_${number}`;
  const lastSent = lastSentNotifications.get(key);
  const now = Date.now();
  
  if (lastSent && (now - lastSent) < 5000) {
    console.log(`[Duplicate] Skipping duplicate notification for ${key} (sent ${now - lastSent}ms ago)`);
    return false;
  }
  
  lastSentNotifications.set(key, now);
  return true;
}

// Helper to add a listener for a sattaname's dates
function addDateListener(sattaname) {
  console.log(`[Setup] Adding listener for game: ${sattaname}`);
  
  let lastKnownNumber = null;
  
  // Listen for date nodes being added/changed (catches update() operations)
  db.ref(`sattanamee/${sattaname}`).on('child_changed', (dateSnap) => {
    const date = dateSnap.key;
    const numberObj = dateSnap.val();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    console.log(`[Child Changed] ${sattaname} - ${date} changed. Today: ${today}`);
    console.log(`[Data] Number object:`, JSON.stringify(numberObj));
    
    if (date === today && numberObj && numberObj.number) {
      const number = numberObj.number;
      if (shouldSendNotification(sattaname, date, number)) {
        console.log(`[Notify] Sending notification for ${sattaname} ${date} number: ${number}`);
        sendNumberNotification(sattaname, date, number);
      }
    } else {
      console.log(`[Skip] Not sending - Date match: ${date === today}, Has number: ${!!(numberObj && numberObj.number)}`);
    }
  });

  // Also listen for value changes on the entire sattaname node (catches set() operations)
  db.ref(`sattanamee/${sattaname}`).on('value', (snapshot) => {
    const allDates = snapshot.val();
    if (!allDates) return;
    
    const today = new Date().toISOString().slice(0, 10);
    
    // Check if today's date exists and has a number
    if (allDates[today] && allDates[today].number) {
      const number = allDates[today].number;
      
      // Only send if the number actually changed
      if (lastKnownNumber !== number) {
        console.log(`[Value Listener] ${sattaname} - Today's number changed from ${lastKnownNumber} to ${number}`);
        lastKnownNumber = number;
        
        if (shouldSendNotification(sattaname, today, number)) {
          console.log(`[Notify] Sending notification for ${sattaname} ${today} number: ${number}`);
          sendNumberNotification(sattaname, today, number);
        }
      } else {
        console.log(`[Value Listener] ${sattaname} - Number unchanged (${number}), skipping`);
      }
    } else {
      lastKnownNumber = null;
    }
  }, (error) => {
    console.error(`[Error] Listener error for ${sattaname}:`, error);
  });
}

// Listen for new sattaname keys
sattanameeRef.on('child_added', (sattanameSnap) => {
  const sattaname = sattanameSnap.key;
  console.log(`[New Game] Detected new game: ${sattaname}`);
  addDateListener(sattaname);
});

// Also add listeners for all existing sattaname keys at startup
sattanameeRef.once('value', (snapshot) => {
  const data = snapshot.val();
  if (!data) {
    console.log('[Startup] No games found in database');
    return;
  }
  const sattanameKeys = Object.keys(data);
  console.log(`[Startup] Found ${sattanameKeys.length} games:`, sattanameKeys);
  sattanameKeys.forEach(addDateListener);
});

// Helper to send notification
async function sendNumberNotification(sattaname, date, number) {
  const title = 'Number Updated!';
  const body = `${sattaname} का आज का नंबर: ${number}`;
  const subsSnap = await db.ref('webPushSubscriptions').once('value');
  const subsObj = subsSnap.val();
  if (!subsObj) return;
  // Deduplicate by endpoint
  const endpointMap = {};
  Object.values(subsObj).forEach(sub => {
    if (sub.endpoint) endpointMap[sub.endpoint] = sub;
  });
  const uniqueSubs = Object.values(endpointMap);
  const payload = JSON.stringify({ title, body });
  for (const sub of uniqueSubs) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      console.error('Failed to send to a subscription:', err.message);
    }
  }
  console.log(`Notification sent for number update on ${date} (${sattaname}) to ${uniqueSubs.length} unique endpoints`);
}

app.get('/', (req, res) => {
  res.send('Web Push Notification Server is running.');
});

app.get('/send-test', async (req, res) => {
  const title = 'Test Notification';
  const body = 'This is a test notification from admin panel.';
  const subsSnap = await db.ref('webPushSubscriptions').once('value');
  const subsObj = subsSnap.val();
  if (!subsObj) return res.status(200).send('No subscribers found.');
  // Deduplicate by endpoint
  const endpointMap = {};
  Object.values(subsObj).forEach(sub => {
    if (sub.endpoint) endpointMap[sub.endpoint] = sub;
  });
  const uniqueSubs = Object.values(endpointMap);
  const payload = JSON.stringify({ title, body });
  let success = 0, fail = 0;
  for (const sub of uniqueSubs) {
    try {
      await webpush.sendNotification(sub, payload);
      success++;
    } catch (err) {
      fail++;
    }
  }
  res.status(200).send(`Notifications sent: ${success}, failed: ${fail}`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
