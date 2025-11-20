/**
 * File-based session storage implementation
 * Stores session state (cookies, CSRF tokens) in JSON files on disk
 */

import * as fs from 'fs';
import * as path from 'path';
import { ISessionStorage, SessionState } from '../logger.js';

export interface FileSessionStorageOptions {
  /**
   * Directory to store session files
   * @default '.sessions'
   */
  sessionDir?: string;

  /**
   * Whether to create session directory if it doesn't exist
   * @default true
   */
  createDir?: boolean;

  /**
   * Pretty-print JSON files (for debugging)
   * @default false
   */
  prettyPrint?: boolean;
}

/**
 * File-based session storage
 * Stores each session in a separate JSON file: .sessions/<sessionId>.json
 */
export class FileSessionStorage implements ISessionStorage {
  private readonly sessionDir: string;
  private readonly prettyPrint: boolean;

  constructor(options: FileSessionStorageOptions = {}) {
    const {
      sessionDir = '.sessions',
      createDir = true,
      prettyPrint = false
    } = options;

    this.sessionDir = path.resolve(process.cwd(), sessionDir);
    this.prettyPrint = prettyPrint;

    if (createDir && !fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Get file path for session
   */
  private getSessionFilePath(sessionId: string): string {
    // Sanitize session ID to prevent path traversal
    const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionDir, `${sanitizedId}.json`);
  }

  /**
   * Save session state to file
   */
  async save(sessionId: string, state: SessionState): Promise<void> {
    const filePath = this.getSessionFilePath(sessionId);
    const data = {
      sessionId,
      timestamp: Date.now(),
      pid: process.pid,
      state
    };

    const json = this.prettyPrint
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);

    await fs.promises.writeFile(filePath, json, 'utf-8');
  }

  /**
   * Load session state from file
   */
  async load(sessionId: string): Promise<SessionState | null> {
    const filePath = this.getSessionFilePath(sessionId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const json = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(json);
      return data.state || null;
    } catch (error) {
      // File corrupted or invalid JSON
      return null;
    }
  }

  /**
   * Delete session state file
   */
  async delete(sessionId: string): Promise<void> {
    const filePath = this.getSessionFilePath(sessionId);

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  /**
   * List all session IDs
   */
  async listSessions(): Promise<string[]> {
    if (!fs.existsSync(this.sessionDir)) {
      return [];
    }

    const files = await fs.promises.readdir(this.sessionDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }

  /**
   * Get session metadata (without loading full state)
   */
  async getSessionMetadata(sessionId: string): Promise<{
    sessionId: string;
    timestamp: number;
    pid: number;
    age: number;
  } | null> {
    const filePath = this.getSessionFilePath(sessionId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const json = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(json);
      return {
        sessionId: data.sessionId,
        timestamp: data.timestamp,
        pid: data.pid,
        age: Date.now() - data.timestamp
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Clean up stale sessions (older than maxAge)
   */
  async cleanupStaleSessions(maxAgeMs: number = 30 * 60 * 1000): Promise<string[]> {
    const sessions = await this.listSessions();
    const stale: string[] = [];
    const now = Date.now();

    for (const sessionId of sessions) {
      const metadata = await this.getSessionMetadata(sessionId);
      if (metadata && (now - metadata.timestamp) > maxAgeMs) {
        await this.delete(sessionId);
        stale.push(sessionId);
      }
    }

    return stale;
  }

  /**
   * Clean up sessions from dead processes
   */
  async cleanupDeadProcessSessions(): Promise<string[]> {
    const sessions = await this.listSessions();
    const dead: string[] = [];

    for (const sessionId of sessions) {
      const metadata = await this.getSessionMetadata(sessionId);
      if (metadata) {
        try {
          // Check if process is still running
          process.kill(metadata.pid, 0);
        } catch (e) {
          // Process doesn't exist
          await this.delete(sessionId);
          dead.push(sessionId);
        }
      }
    }

    return dead;
  }

  /**
   * Clear all sessions
   */
  async clearAll(): Promise<void> {
    const sessions = await this.listSessions();
    for (const sessionId of sessions) {
      await this.delete(sessionId);
    }
  }
}
