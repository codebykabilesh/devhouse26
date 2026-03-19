import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SignalAggregator } from './signalAggregator';
import { ActivityMonitor } from './activityMonitor';
import { WebhookSender } from './webhookSender';
import { CommitMetadata, SupaBaseEvent, ExtensionConfig } from './types';
import { logger } from './extension';

export class GitListener {
    private aggregator: SignalAggregator;
    private activityMonitor: ActivityMonitor;
    private webhookSender: WebhookSender;
    private disposables: vscode.Disposable[] = [];
    private lastCommitIds: Map<string, string> = new Map();
    private config!: ExtensionConfig;

    constructor(
        aggregator: SignalAggregator, 
        activityMonitor: ActivityMonitor,
        webhookSender: WebhookSender
    ) {
        this.aggregator = aggregator;
        this.activityMonitor = activityMonitor;
        this.webhookSender = webhookSender;
        this.updateConfig();

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('devintel')) {
                this.updateConfig();
            }
        });
        
        logger.appendLine("[INIT] GitListener created");
    }

    private updateConfig(): void {
        const config = vscode.workspace.getConfiguration('devintel');
        this.config = {
            supabaseUrl: config.get<string>('supabaseUrl', 'https://sgszqmuqwjghogtfuhbq.supabase.co'),
            supabaseKey: config.get<string>('supabaseKey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnc3pxbXVxd2pnaG9ndGZ1aGJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5MjE3MDIsImV4cCI6MjA4OTQ5NzcwMn0.kZbXvIIRnMq6gdWrowF9MKOkEgFCHlkuNaf6kT-QaSM'),
            developerId: config.get<string>('developerId', 'dev_22'),
            repositoryName: config.get<string>('repositoryName', 'payment-service'),
            telemetryEnabled: config.get<boolean>('telemetryEnabled', true)
        };
        this.webhookSender.updateConfig(this.config.supabaseUrl, this.config.supabaseKey);
    }

    public async initialize(): Promise<void> {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            logger.appendLine("[ERROR] VS Code Git extension not found.");
            return;
        }

        const gitAPI = gitExtension.isActive ? gitExtension.exports.getAPI(1) : await gitExtension.activate().then(() => gitExtension.exports.getAPI(1));

        if (!gitAPI) {
            logger.appendLine("[ERROR] Could not get Git API.");
            return;
        }

        const setupRepo = async (repo: any) => {
            const repoPath = repo.rootUri.fsPath;
            logger.appendLine(`[INIT] Monitoring repository: ${repoPath}`);
            
            if (repo?.state?.HEAD?.commit) {
                this.lastCommitIds.set(repo.rootUri.toString(), repo.state.HEAD.commit);
            }

            // Sync any existing events that haven't been sent yet
            await this.syncExistingEvents(repoPath);

            // 1. Listen to internal VS Code Git state changes
            this.disposables.push(
                repo.state.onDidChange(() => {
                    const repoName = path.basename(repo.rootUri.fsPath);
                    logger.appendLine(`[EVENT] Git state changed for ${repoName}`);
                    this.checkForNewCommit(repo);
                })
            );

            // 2. Add a FileSystemWatcher for external commits (e.g. Git Bash)
            const gitHeadPattern = new vscode.RelativePattern(repo.rootUri, '.git/HEAD');
            const watcher = vscode.workspace.createFileSystemWatcher(gitHeadPattern);
            
            watcher.onDidChange(() => {
                logger.appendLine(`[EVENT] External Git activity detected (HEAD changed)`);
                setTimeout(() => this.checkForNewCommit(repo), 1000);
            });
            
            this.disposables.push(watcher);
        };

        if (gitAPI.repositories.length > 0) {
            for (const repo of gitAPI.repositories) {
                await setupRepo(repo);
            }
        } else {
            this.disposables.push(
                gitAPI.onDidOpenRepository(async (repo: any) => {
                    await setupRepo(repo);
                })
            );
        }
    }

    private async syncExistingEvents(repoPath: string) {
        const eventsDir = path.join(repoPath, '.devpulse', 'events');
        const syncedDir = path.join(eventsDir, 'synced');
        
        if (!fs.existsSync(eventsDir)) return;
        if (!fs.existsSync(syncedDir)) {
            fs.mkdirSync(syncedDir, { recursive: true });
        }

        try {
            const files = fs.readdirSync(eventsDir);
            const pendingFiles = files.filter(f => f.endsWith('.json'));

            if (pendingFiles.length === 0) return;

            logger.appendLine(`[SYNC] Found ${pendingFiles.length} pending events. Attempting sync...`);

            for (const file of pendingFiles) {
                const filePath = path.join(eventsDir, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const event = JSON.parse(content) as SupaBaseEvent;
                    
                    // Attempt to send to Supabase
                    const success = await this.webhookSender.sendToSupabase(event);
                    
                    if (success) {
                        // Move to synced folder
                        const destPath = path.join(syncedDir, file);
                        fs.renameSync(filePath, destPath);
                        logger.appendLine(`[SYNC] Successfully synced and moved ${file}`);
                    }
                } catch (err) {
                    logger.appendLine(`[SYNC] Failed to sync ${file}: ${err}`);
                }
            }
        } catch (err) {
            logger.appendLine(`[ERROR] Failed to scan events directory: ${err}`);
        }
    }

    private async checkForNewCommit(repo: any): Promise<void> {
        if (!this.config.telemetryEnabled) {
            return;
        }

        const head = repo.state.HEAD;
        if (!head || !head.commit) {
            return;
        }

        const currentCommitId = head.commit;
        const repoUri = repo.rootUri.toString();
        const previousCommitId = this.lastCommitIds.get(repoUri);

        if (previousCommitId !== currentCommitId) {
            logger.appendLine(`[DETECTED] New commit! ${previousCommitId?.substring(0,7)} -> ${currentCommitId.substring(0,7)}`);
            this.lastCommitIds.set(repoUri, currentCommitId);

            try {
                const commitDetails = await repo.getCommit(currentCommitId);
                const repoPath = repo.rootUri.fsPath;
                
                logger.appendLine(`[PROCESS] Extracting metrics for commit ${currentCommitId.substring(0,7)}...`);
                const stats = await this.getCommitStats(currentCommitId, repoPath);
                
                // FILTER: Only send if there are actual changes
                if (stats.filesChangedCount === 0 && stats.locAdded === 0 && stats.locDeleted === 0) {
                    logger.appendLine(`[SKIP] Commit ${currentCommitId.substring(0,7)} has no changes. Skipping sync.`);
                    this.lastCommitIds.set(repoUri, currentCommitId);
                    return;
                }
                const meta: CommitMetadata = {
                    commit_id: currentCommitId,
                    branch: head.name || 'main',
                    commit_message: commitDetails.message || '',
                    files_changed: stats.filesChangedCount
                };

                const supabaseEvent = this.buildSupaBaseEvent(meta, stats);
                
                // Process locally: Save to JSON file
                const filePath = await this.saveEventLocally(supabaseEvent, repoPath);

                // Send to Supabase
                const success = await this.webhookSender.sendToSupabase(supabaseEvent);
                
                if (success && filePath) {
                    this.moveToSynced(filePath);
                }
                
                // Reset for the next session
                this.aggregator.resetSession();
                this.activityMonitor.resetTracker();

            } catch (error) {
                logger.appendLine(`[ERROR] Failed to process new commit: ${error}`);
            }
        }
    }

    private async getCommitStats(commitId: string, repoPath: string) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
            // 1. Files changed count and raw stats
            const { stdout: statOut } = await execAsync(`git show --shortstat --format="" ${commitId}`, { cwd: repoPath });
            let locAdded = 0, locDeleted = 0, filesChangedCount = 0;
            const match = statOut.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
            if (match) {
                filesChangedCount = parseInt(match[1] || '0');
                locAdded = parseInt(match[2] || '0');
                locDeleted = parseInt(match[3] || '0');
            }

            // 2. Diff patch
            const { stdout: diffPatch } = await execAsync(`git show --format="" ${commitId}`, { cwd: repoPath });

            // 3. Files list and types
            const { stdout: filesListOut } = await execAsync(`git diff-tree --no-commit-id --name-only -r ${commitId}`, { cwd: repoPath });
            const files = filesListOut.trim().split('\n').filter(f => f.length > 0);
            
            const testFilesChanged = files.some(f => f.toLowerCase().includes('test') || f.toLowerCase().includes('spec'));
            
            // 4. Modules touched (top level dirs)
            const modulesSet = new Set<string>();
            files.forEach(f => {
                const parts = f.split('/');
                if (parts.length > 1) modulesSet.add(parts[0]);
                else modulesSet.add('.');
            });

            // 5. Check if merge commit
            const { stdout: parents } = await execAsync(`git show -s --format=%P ${commitId}`, { cwd: repoPath });
            const isMergeCommit = parents.trim().split(' ').length > 1;

            return {
                locAdded, locDeleted, filesChangedCount, diffPatch, files, testFilesChanged, 
                modulesTouched: Array.from(modulesSet), isMergeCommit
            };
        } catch (err) {
            logger.appendLine(`[ERROR] Git CLI failed: ${err}`);
            return {
                locAdded: 0, locDeleted: 0, filesChangedCount: 0, diffPatch: '', files: [], 
                testFilesChanged: false, modulesTouched: [], isMergeCommit: false
            };
        }
    }

    private buildSupaBaseEvent(meta: CommitMetadata, stats: any): SupaBaseEvent {
        const session = this.aggregator.getSession();
        
        const issueMatch = meta.commit_message.match(/#(\d+)/) || meta.commit_message.match(/([A-Z]{2,}-\d+)/);
        const issueId = issueMatch ? issueMatch[0] : undefined;

        return {
            event_type: "commit_event",
            schema_version: "1.0",
            developer_id: this.config.developerId,
            repo: this.config.repositoryName,
            client_timestamp: Date.now(),
            commit_hash: meta.commit_id,
            branch: meta.branch,
            commit_message: meta.commit_message,
            issue_id: issueId,
            is_merge_commit: stats.isMergeCommit,
            loc_added: stats.locAdded,
            loc_deleted: stats.locDeleted,
            net_loc: stats.locAdded - stats.locDeleted,
            files_changed_count: stats.filesChangedCount,
            test_files_changed: stats.testFilesChanged,
            modules_touched: stats.modulesTouched,
            diff_patch: stats.diffPatch.substring(0, 10000), 
            files_json: { files: stats.files },
            active_minutes: session.editing_duration_minutes,
            idle_minutes: 0, 
            focus_ratio: 1.0, 
            debug_session_count: 0 
        };
    }

    private async saveEventLocally(event: SupaBaseEvent, repoPath: string): Promise<string | undefined> {
        try {
            const devPulseDir = path.join(repoPath, '.devpulse', 'events');
            if (!fs.existsSync(devPulseDir)) {
                fs.mkdirSync(devPulseDir, { recursive: true });
            }
            
            const fileName = `${event.commit_hash}.json`;
            const filePath = path.join(devPulseDir, fileName);
            fs.writeFileSync(filePath, JSON.stringify(event, null, 2));
            
            logger.appendLine(`[LOCAL] Saved commit data to: ${filePath}`);
            return filePath;
        } catch (err) {
            logger.appendLine(`[ERROR] Failed to save local JSON: ${err}`);
            return undefined;
        }
    }

    private moveToSynced(filePath: string) {
        try {
            const dir = path.dirname(filePath);
            const fileName = path.basename(filePath);
            const syncedDir = path.join(dir, 'synced');
            
            if (!fs.existsSync(syncedDir)) {
                fs.mkdirSync(syncedDir, { recursive: true });
            }
            
            const destPath = path.join(syncedDir, fileName);
            fs.renameSync(filePath, destPath);
            logger.appendLine(`[SYNC] Moved to synced folder: ${fileName}`);
        } catch (err) {
            logger.appendLine(`[ERROR] Failed to move file to synced: ${err}`);
        }
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
