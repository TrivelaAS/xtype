# Project Rules — XType / Typed PostX (`c:\claudeprojects\xtype`)

## Critical Platform Constraint (X.com Anti-Automation)
- **NEVER use or suggest Chrome DevTools Protocol (`chrome.debugger`, CDP, Puppeteer/Playwright/DevTools connections) for X.com.** X will block/stop traffic coming from a Chrome DevTools-attached window.
- **Allowed approach ONLY:** Ordinary Chrome or Firefox browser UI combined with OS-level human behavior replication (e.g., native Windows `SendInput` keystrokes in `TypedPostX.Keyboard.exe` with realistic human timing/cadence).
- **Important operational note:** Always launch `Start Typed PostX.cmd` (`TypedPostX.Tray.exe`) from the user's interactive Windows desktop (Explorer / terminal), never from an agent's sandboxed `run_command` session, because sandboxed sessions run in an isolated Windows desktop (`exebox`) that cannot see interactive foreground windows.
