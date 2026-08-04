# Server Environment & Resource Constraints

> [!IMPORTANT]
> **Server Hardware Specs:**
> - CPU: 2 Cores
> - Memory: 512 MB RAM

## Guidelines & Precautions for AI Agents

1. **Strict Memory & CPU Usage Control**
   - The server has very limited memory (512MB RAM). High memory usage will lead to Out-Of-Memory (OOM) panics or freeze the entire server.
   - Avoid executing high-memory commands, running multiple heavy background services simultaneously, or performing resource-intensive compilations/builds without strict limits.

2. **Dependency & Build Operations**
   - When installing Python packages, NPM packages, or building assets, do not run parallel jobs that consume high memory.
   - Use low-resource flags where applicable (e.g., `--no-cache-dir` for pip if memory is low, limiting job threads).

3. **Code Editing & Task Execution**
   - Keep tasks lightweight, clean up background processes immediately after testing, and ensure no lingering processes consume CPU/RAM.
