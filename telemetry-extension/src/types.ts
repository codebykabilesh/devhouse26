export interface SignalSession {
    session_id: string;
    files_opened: number;
    files_modified: number;
    lines_added: number;
    lines_deleted: number;
    editing_duration_minutes: number;
    refactor_events: number;
}

export interface CommitMetadata {
    commit_id: string;
    branch: string;
    commit_message: string;
    files_changed: number;
}

// Supabase schema-aligned event
export interface SupaBaseEvent {
    id?: string;
    event_type: string;
    schema_version: string;
    developer_id: string;
    repo: string;
    client_timestamp: number;
    commit_hash: string;
    branch: string;
    commit_message: string;
    issue_id?: string;
    is_merge_commit: boolean;
    loc_added: number;
    loc_deleted: number;
    net_loc: number;
    files_changed_count: number;
    test_files_changed: boolean;
    modules_touched: string[];
    diff_patch: string;
    files_json: any;
    active_minutes: number;
    idle_minutes: number;
    focus_ratio: number;
    debug_session_count: number;
}

export interface ExtensionConfig {
    supabaseUrl: string;
    supabaseKey: string;
    developerId: string;
    repositoryName: string;
    telemetryEnabled: boolean;
}
