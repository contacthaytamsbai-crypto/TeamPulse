# TeamPulse — Team progress tracker (v1.3)

A responsive team workspace with task statuses, live online/offline presence, and invitation-based teammate account setup.

## Features

- First-run workspace setup; the first account becomes the admin.
- Admin can invite teammates by name and username.
- Each invitation has a one-time 10-character code. The code is shown to the admin when the invitation is created; only its hash is stored.
- Admin sees a ready-to-send invitation URL plus the code. The URL opens **Create account** and pre-fills username and code.
- Invitations expire after 30 days. Admins can generate a fresh invitation link for a teammate who has not registered yet.
- Create tasks, assign members, set priority and deadline.
- Change task status to Pending, In progress, Review, Completed or Blocked.
- Live task updates and online/offline presence using Socket.IO.
- Dashboard, activity feed, filters and progress summary.
- JSON file persistence in `data/team-data.json` (configure a persistent volume for hosted deployment).

## Deploy for a team in different cities (Railway)

The app is a Node.js/Express server with Socket.IO. GitHub stores the source code; it does not run this backend. Deploy the repository as a **Railway Service** (not GitHub Pages).

1. Push this repository to GitHub and sign in to Railway using the GitHub account that can access it.
2. In Railway, create a new project and choose **Deploy from GitHub repo**. Select `TeamPulse`. Railway detects the included `Dockerfile`.
3. Open the service settings and generate a Railway public domain. Railway provides an HTTPS address such as `https://your-service.up.railway.app`.
4. Add a Railway Volume to this service and set its mount path to **`/app/data`**. This is essential: the Dockerfile sets `DATA_DIR=/app/data`, where TeamPulse writes `team-data.json`. Without a persistent volume, user accounts and tasks can be lost when the container is replaced.
5. Deploy/redeploy the service and open **Settings → Networking → Generate Domain** if the domain was not generated earlier.
6. Optional custom domain: buy a domain from a registrar, add it under the Railway service's custom domains, then copy the DNS records Railway gives you into the registrar's DNS settings. Railway provisions HTTPS for the domain.
7. Use the public HTTPS domain when creating invitation links. Since links use the current site origin, invite links generated from the deployed app will use the public domain automatically.

The app exposes `GET /api/health` for a simple hosting health check. The app listens on `0.0.0.0` and reads Railway's `PORT` environment variable.

## Local development on Windows

1. Install Node.js 20 LTS or newer from https://nodejs.org/.
2. Extract this folder to a normal location such as `C:\TeamPulse`.
3. Double-click `start.bat`.
4. On first launch, create the admin workspace account.
5. Open **Team → Invite teammate**, enter their name and username, create the invitation, then send the invitation link privately.

The app runs at `http://localhost:3000`. For a local Wi-Fi test only, another device on the same network can use the host PC's local IP and port 3000. For teammates elsewhere, use the deployed HTTPS domain instead. Do not expose port 3000 directly to the public internet.

## Upgrade without losing local data

1. Stop the old TeamPulse server.
2. Back up the old `data` folder, especially `data/team-data.json`.
3. Copy the new application files over the existing TeamPulse folder. Keep the existing `data` folder; do not delete it.
4. Run `start.bat` again. Existing accounts and tasks remain in the same JSON database.

## Online / offline behavior

A member is online while at least one signed-in app connection is active. Closing the tab, signing out, losing the network connection or closing the server causes them to appear offline. Presence is an app-session indicator; it does not monitor a person's device outside the app.

## Security notes

- Passwords are hashed using Node.js `scrypt`; invitation codes are stored only as SHA-256 hashes and can be used once.
- Use HTTPS whenever the app is reachable over an untrusted network.
- Keep the `data` folder out of GitHub; `.gitignore` and `.dockerignore` exclude it.
- This is an MVP, not an enterprise-audited product. Back up the persistent volume regularly.
