# 🤖 Saveetha Slot Booker & Learner Bot

A robust, fully automated headless scraper and Telegram bot designed specifically for the Saveetha Engineering College Learner Portal. Built using Node.js and Playwright, this project runs persistently on GitHub Actions to provide instantaneous slot booking, attendance tracking, bunk calculations, and daily class reminders directly through Telegram.

---

## 🌟 Key Features

### 📅 Advanced Slot Booking
The core functionality automates the tedious process of booking academic slots, bypassing portal lag and competing students.
- **Instant Booking (`!book <keyword>`)**: Immediately scans and books the first available slot matching the keyword.
- **Targeted Time Booking (`!book <keyword> @ 10:00 AM`)**: Specifically targets slots occurring at a given time.
- **Venue Specific Booking (`!book <keyword> $ 5511`)**: Hunts down and books a slot in a specific room or venue.
- **Delayed Start Scanning (`!book <keyword> # 06:00 PM`)**: Queues the bot to idle and only begin actively scanning at a scheduled time (e.g., exactly when slots are released).
- **Continuous Scanning (`!scan <keyword>`)**: If a slot is full, the bot will relentlessly refresh every 30 seconds until someone drops the class and a seat opens up.
- **Unbooking (`!unbook <keyword>`)**: Safely cancels a previously booked slot.

### 📊 Attendance & Analytics
- **Live Attendance (`!att` or `!attendance`)**: Scrapes the portal to provide a live, organized summary of your overall and subject-wise attendance percentages, complete with visual health indicators (🟢 Safe, 🟡 Warning, 🔴 Shortage).
- **Smart Bunk Calculator (`!bunk <keyword>`)**: The bot deeply analyzes the total scheduled sessions and remaining upcoming classes to mathematically calculate exactly how many classes you can afford to skip (or need to attend) to maintain a strict **80% attendance threshold**. 

### ⏱️ Timetable & Automated Reminders
- **Daily Timetable (`!tt` or `!timetable`)**: Instantly fetches today's academic schedule, including subjects, timings, and exact venues.
- **Proactive Reminders**: The bot runs a continuous background cron job that automatically sends a Telegram ping **15 minutes before** every single class, ensuring you never miss a session.

### 👥 Multi-User & Admin System
- **GitHub Gist Persistence**: Acts as a remote database to persist authorized users across GitHub Action restarts.
- **Hot-Tab Architecture**: Maintains active, pre-authenticated Playwright browser tabs for every registered user in the background, ensuring 0-second latency when a booking command is issued.
- **Admin Controls**:
  - `!adduser <chat_id> <username> <password> <name>`: Onboard a new student.
  - `!removeuser <chat_id>`: Revoke access.
  - `!listusers`: View all active users and their session status.

### 🛠️ System Management
- `!status`: Checks the bot's health and active login state.
- `!progress`: Lists all currently running background scans/tasks.
- `!stop <keyword>` / `!stop all`: Instantly terminates specific (or all) background scraping loops.

---

## 🏗️ Architecture & Technologies

- **Playwright**: Powers the headless browser automation, seamlessly handling modern SPA (Single Page Application) interactions and dynamic DOM loads on the Saveetha portal.
- **GitHub Actions (`.github/workflows/book.yml`)**: Acts as the host server. The bot is scheduled to run persistently, automatically restarting itself every 5 hours to bypass GitHub's 6-hour execution limits.
- **Telegram Bot API**: The primary user interface, providing cross-platform mobile access to the automation engine without requiring users to run any local software.
- **Chrome Extension (Legacy/Companion)**: The repository also houses `content.js` and extension scripts for local, on-browser DOM manipulation capabilities.

---

## 🚀 Setup & Deployment

1. **Fork/Clone the Repository.**
2. **Set up GitHub Secrets**:
   Navigate to `Settings > Secrets and variables > Actions` and add the following:
   - `TELEGRAM_BOT_TOKEN`: Your Telegram Bot API token.
   - `CHAT_ID`: Your personal Telegram ID (to act as the super-admin).
   - `SAVEETHA_USER` & `SAVEETHA_PASS`: Your default portal credentials.
   - `GIST_ID` & `GIST_TOKEN`: A GitHub Gist ID and Personal Access Token used as a cloud database to persist dynamically added users.
3. **Trigger the Action**: Go to the GitHub Actions tab and manually run the `Run Persistent Telegram Bot` workflow.

---

## 🔒 Security & Privacy
- **No Local Databases**: User credentials are not stored in the repository. They are either securely stored in GitHub Secrets or encrypted in a private GitHub Gist.
- **Session Isolation**: Playwright handles each user in a completely isolated browser context, ensuring no cross-contamination of sessions or cookies.
