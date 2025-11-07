# Backend for Automated Web Push Notifications

This folder contains the backend server for sending automated web push notifications when an admin updates a number for the current date.

## Files
- `server.cjs`: Express server that listens for number updates and sends notifications to all subscribers.
- `serviceAccountKey.json`: Your Firebase Admin SDK key (not included, add your own).

## How to Use
1. Place your `serviceAccountKey.json` in this folder.
2. Install dependencies:
   ```sh
   npm install express web-push firebase-admin
   ```
3. Start the server:
   ```sh
   node server.cjs
   ```
4. Deploy this folder to Render or your preferred Node.js host.

## Notes
- The server listens for changes on the `numbers` node in your Firebase Realtime Database.
- When a number is updated for today, all web push subscribers will receive a notification.
- Update the database path in `server.cjs` if your numbers are stored elsewhere.
