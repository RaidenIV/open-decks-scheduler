# XODIA Real-Time Schedule

A shared 8:00 PM–1:30 AM schedule with 30-minute slots, MongoDB persistence, live Socket.IO updates, notes, and touch-friendly drag reordering.

## Project layout

- `docs/` — static frontend for GitHub Pages
- `server.js` — Railway API and Socket.IO server
- `models/Schedule.js` — MongoDB schedule model

## 1. Create the GitHub repository

1. Create a new GitHub repository.
2. Upload every file and folder from this project.
3. Commit the files to the `main` branch.

## 2. Deploy the backend to Railway

1. Create a new Railway project from the GitHub repository.
2. Add a MongoDB service to the Railway project.
3. Open the app service’s variables.
4. Add `MONGODB_URI` using the MongoDB service reference variable.
   - `MONGO_URL` is also supported.
5. Add `CLIENT_ORIGINS` with the final GitHub Pages origin.

Example:

```text
https://YOUR-GITHUB-USERNAME.github.io
```

For a project site, the browser origin is still only the protocol and domain; do not include the repository path.

6. Deploy the service.
7. Confirm this URL returns a successful response:

```text
https://YOUR-RAILWAY-SERVICE.up.railway.app/api/health
```

## 3. Connect the GitHub Pages frontend

Open `docs/config.js` and replace:

```text
https://YOUR-RAILWAY-SERVICE.up.railway.app
```

with the Railway service URL.

Commit and push that one change.

## 4. Enable GitHub Pages

1. Open the repository’s **Settings**.
2. Open **Pages**.
3. Choose **Deploy from a branch**.
4. Select the `main` branch.
5. Select the `/docs` folder.
6. Save.

GitHub will provide the public schedule URL.

## Behavior

- Names save automatically after typing stops.
- Notes save from the notes modal.
- A note icon appears when a slot has notes.
- Dragging a slot changes its position; the visible time is reassigned automatically.
- Every successful edit is stored in MongoDB and broadcast to all connected viewers.
- The Railway service also serves the frontend at its root URL for direct testing.

## Local run

Set `MONGODB_URI`, then run:

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```
