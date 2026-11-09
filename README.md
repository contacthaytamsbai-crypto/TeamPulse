# TeamPulse — Team progress tracker (v1.3)

A responsive team workspace with task statuses, live online/offline presence, and invitation-based teammate account setup.

## Features

- First-run workspace setup; the first account becomes the admin.
- Admin can invite teammates by name and username.
- Each invitation has a one-time 10-character code. The code is shown to the admin when the invitation is created; only its hash is stored.
- Admin sees a ready-to-send invitation URL plus the code. The URL opens **Create account** and pre-fills username and code so teammates do not need to type the code manually.
- Invitations expire after 30 days. Admins can generate a fresh invitation link for a teammate who has not registered yet.
- Create tasks, assign members, set priority and deadline.
- Change task status to Pending, In progress, Review, Completed or Blocked.
- Live task updates and online/offline presence using Socket.IO.
- Dashboard, activity feed, filters and progress summary.
- JSON file persistence in `data/team-data.json`.

## Run on Windows

1. Install Node.js 20 LTS or newer from https://nodejs.org/.
2. Extract this folder to a normal location such as `C:\TeamPulse`.
3. Double-click `start.bat`.
4. On first launch, create the admin workspace account.
5. Open **Team → Invite teammate**, enter their name and username, and create the invitation.
6. In the invitation panel, choose the correct link address. Use a local-network address for teammates on the same Wi-Fi, or the public HTTPS address for teammates elsewhere.
7. Click **Copy invitation link** and send it privately. The link opens Create account with username and invitation code pre-filled; the teammate only needs to choose and confirm a password.

The app runs at `http://localhost:3000`. The invitation panel also lists detected local IPv4 addresses so you can make links reachable by teammates on the same Wi-Fi.

## Upgrade from TeamPulse v1 / v1.1 without losing data

1. Stop the old TeamPulse server.
2. Make a backup copy of the old `data` folder (especially `data/team-data.json`).
3. Copy the new v1.3 application files over the existing TeamPulse folder. Keep the existing `data` folder; do not delete it.
4. Run `start.bat` again. Existing admin/member accounts and tasks remain in the same JSON database.
5. Existing accounts continue to use their existing passwords/PINs unless you explicitly choose **Generate invite link** for them. New teammates use the invitation-based **Create account** flow.
6. For an existing member who should choose their own password, use **Generate invite link** on the Team page and share the new link. The teammate opens it to set a new password. Alternatively, **Reset password** lets the admin set a temporary password.

## Let teammates connect on the same Wi-Fi

1. Keep the app running on the host PC.
2. On the host PC, open Command Prompt and run `ipconfig`.
3. Find the active Wi-Fi adapter's **IPv4 Address** (for example `192.168.1.25`).
4. Teammates on the same network open `http://192.168.1.25:3000` (replace with the actual IP).
5. If Windows Firewall asks, allow Node.js on your **Private network** only.

Do not expose port 3000 directly to the public internet. For access from different locations, deploy behind HTTPS on a VPS or trusted hosting platform and use persistent storage for the `data` folder. The included Dockerfile can be used for VPS deployment.

## Online / offline behavior

A member is online while at least one signed-in app connection is active. Closing the tab, signing out, losing the network connection or closing the server causes them to appear offline. Presence is an app-session indicator; it does not monitor a person's device outside the app.

## Data and security

- All app records are stored in `data/team-data.json`. Stop the server before manually copying this file for backup.
- Passwords are hashed using Node.js `scrypt`; invitation codes are stored only as SHA-256 hashes and can be used once.
- Use HTTPS whenever the app is reachable over an untrusted network.
- This is an MVP, not an enterprise-audited product.
