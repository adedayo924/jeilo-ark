# Jeilo ARK

1. Install Node.js (nodejs.org), then in this folder run:
       npm install
       npm test    # runs the automated unit test suite
       npm start
2. Pick a provider in the top bar:
   - Local: Ollama or LM Studio (make sure the server is running, e.g. `ollama serve`).
   - Cloud: NVIDIA. Click "Set API key" and paste a key from build.nvidia.com (it starts with `nvapi-`), then type or pick a model name, for example `meta/llama-3.3-70b-instruct`.
   - Custom: any OpenAI-compatible endpoint. Enter its URL (ending in /v1) and an API key if it needs one.
3. Click Open folder and chat.

The folder you open is watched for changes. Clean open files reload automatically when they change on disk; tabs with unsaved edits are left untouched. Use "+ File" and "+ Folder" in the sidebar to create files and directories, or hover any item to rename (✎) or delete (✕) it. The file tree refreshes when files are created, renamed, or deleted. Use the theme button in the top bar to cycle auto / light / dark.

## Editor and shortcuts
- `Ctrl+P` quick open, `Ctrl+Shift+F` search in files, `Ctrl+Shift+A` add selection to chat, `Ctrl+\`` toggle terminal, `Alt+Z` toggle word wrap.
- AI Tab autocomplete is on by default; toggle it with the "AI tab" button in the footer. It uses the selected model.
- The assistant's file edits open an inline diff first. Accept (`Ctrl+Enter`) or reject (`Esc`) each edit, or enable "Allow all file edits in this chat".

## Agent, terminal, and project rules
- The assistant can read, write, search, and run commands. Command output streams into the integrated terminal with full ANSI color support, where you can also run your own commands in the project root. `Stop` cleanly kills running process trees, and `Esc` interrupts the assistant.
- **Windows POSIX Compatibility**: On Windows 11 / 10, common Unix utility commands (`wc`, `head`, `tail`, `grep`, `touch`, `which`, `cat`, `ls`, `pwd`, `clear`, `rm`, `cp`, `mv`) are natively shimmed in the `shims/` directory. They work seamlessly across both the integrated terminal and AI agent executions without requiring WSL or Git Bash.
- Project rules are always included in the assistant's system prompt. Jeilo ARK looks for `JEILO.md`, `AGENTS.md`, `CLAUDE.md`, `.jeilorules`, or `.cursorrules` at the project root and uses the first one found. Create `JEILO.md` from the sidebar Rules button.

## Sign-in (optional)
Jeilo ARK works in local mode out of the box without signing in. You can optionally sign in with GitHub or Google from the top bar if you want your account profile displayed.

GitHub uses the OAuth device flow. Create a GitHub OAuth App at `https://github.com/settings/developers` (the callback URL can be `https://github.com`), enable **Enable Device Flow**, and paste its **Client ID** into the sign-in screen (or set `JEILO_GITHUB_CLIENT_ID`). No client secret is needed, and the app requests the `read:user` scope. New users can create a GitHub account from the sign-in screen.

Google uses the desktop OAuth loopback flow. In Google Cloud Console, configure an OAuth consent screen, create an OAuth client ID of type **Desktop app**, and paste the client ID and secret into the sign-in screen (or set `JEILO_GOOGLE_CLIENT_ID` and `JEILO_GOOGLE_CLIENT_SECRET`). If the consent screen is in testing mode, add your account as a test user. The app opens the browser, receives the callback on `http://127.0.0.1:<random-port>/oauth2callback`, and requests `openid email profile` with offline access.

Both providers store tokens with `safeStorage` encryption, verify the session on startup when online, and provide **Sign out** in the header.

## Git
The Git panel shows the current branch and changed files, and supports stage, unstage, and commit. "Generate with AI" asks the selected model to write a commit message from the diff; edit it before committing if you like.

The GitHub section is separate from the IDE sign-in and connects with a personal access token (classic tokens need the `repo` scope; fine-grained tokens need repository Contents read/write access). The token is validated with GitHub, kept in the main process, and encrypted on disk with the OS-provided encryption via Electron `safeStorage`. It is never written to `.git/config` or embedded in a remote URL. Save an HTTPS repository URL as `origin`, then use Push or Pull. Push sets the upstream to `origin/<current-branch>`; Pull uses `--ff-only` to avoid surprise merge commits. SSH GitHub remotes are converted to HTTPS for authenticated push/pull.

## PHP preview
The Preview panel shows any URL. "Run PHP" starts `php -S` using the current PHP/HTML file, or `index.php`/`index.html`, and loads it in the preview. PHP must be installed and on `PATH`.

## Extensions Hub
Click the **Extensions** tab in the sidebar to browse, search, and manage extensions:
- **MCP Tool Extensions**: One-click install Model Context Protocol tools for the assistant (OpenCode Agent, SQLite Explorer, Web Fetcher, Filesystem Deep Search, Puppeteer Browser Automation, GitHub Tools). They are automatically saved to `.jeilo/mcp.json` and activated immediately.
- **Custom MCP Servers**: Add any external MCP server by specifying its command (e.g. `npx`, `python`, `docker`) and arguments in the sidebar.
- **Themes**: One-click install and switch themes: Dracula Dark, One Dark Pro, Nord Frost, Monokai Pro, GitHub Dark, and Solarized Light. Custom themes immediately re-skin both Monaco Editor and the IDE interface.
- **AI Skills & Rules**: Install specialized engineering guidelines into `JEILO.md` (Next.js 15 & React 19, Python FastAPI, Rust Systems, OWASP Security Auditor, TDD Testing Coach).

## MCP tools
Add MCP servers in `.jeilo/mcp.json` (or `mcp.json` / `.mcp.json`):
```json
{
  "mcpServers": {
    "example": { "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```
Tools appear to the assistant as `mcp__<server>__<tool>` and require your approval for each call. Click the MCP status in the footer to reload servers.

API keys are kept in the app's main process and stored encrypted with your operating system's keychain when available. They are never shown in the interface or sent anywhere except the provider you chose.
In cloud mode your messages and any file contents you share are sent to that provider.

Local server URLs: Ollama http://localhost:11434/v1 | LM Studio http://localhost:1234/v1 | llama.cpp http://localhost:8080/v1
The model must support tool calling for file access (e.g. llama3.1, qwen2.5-coder, mistral-nemo).
