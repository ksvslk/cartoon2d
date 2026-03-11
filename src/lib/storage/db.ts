import { get, set, del } from 'idb-keyval';
import { StoryGenerationData, StageOrientation } from '../schema/story';

export interface ProjectMetadata {
    id: string;
    title: string;
    updatedAt: number;
    orientation?: StageOrientation;
}

const PROJECTS_LIST_KEY = 'cartoon2d_projects_list';
const ACTOR_DB_KEY = 'cartoon2d_actor_db';

/**
 * Helper to get the key for a specific project's story data
 */
const getStoryKey = (projectId: string) => `cartoon2d_story_${projectId}`;

/**
 * Project Management API
 */
export async function getProjectsList(): Promise<ProjectMetadata[]> {
    try {
        const list = await get<ProjectMetadata[]>(PROJECTS_LIST_KEY);
        return list || [];
    } catch (e) {
        console.error("Failed to load projects list from IndexedDB:", e);
        return [];
    }
}

export async function createProject(title: string): Promise<ProjectMetadata> {
    try {
        const projects = await getProjectsList();
        const newProject: ProjectMetadata = {
            id: crypto.randomUUID(),
            title,
            updatedAt: Date.now()
        };
        await set(PROJECTS_LIST_KEY, [...projects, newProject]);
        return newProject;
    } catch (e) {
        console.error("Failed to create project:", e);
        throw e;
    }
}

export async function updateProjectTitle(projectId: string, title: string): Promise<void> {
    try {
        const projects = await getProjectsList();
        const updated = projects.map(p => p.id === projectId ? { ...p, title, updatedAt: Date.now() } : p);
        await set(PROJECTS_LIST_KEY, updated);
    } catch (e) {
        console.error(`Failed to update project title for ${projectId}:`, e);
    }
}

export async function touchProject(projectId: string): Promise<void> {
    try {
        const projects = await getProjectsList();
        const updated = projects.map(p => p.id === projectId ? { ...p, updatedAt: Date.now() } : p);
        // Sort by updatedAt descending
        updated.sort((a, b) => b.updatedAt - a.updatedAt);
        await set(PROJECTS_LIST_KEY, updated);
    } catch (e) {
        console.error(`Failed to touch project ${projectId}:`, e);
    }
}

export async function updateProjectOrientation(projectId: string, orientation: StageOrientation): Promise<void> {
    try {
        const projects = await getProjectsList();
        const updated = projects.map(p => p.id === projectId ? { ...p, orientation, updatedAt: Date.now() } : p);
        await set(PROJECTS_LIST_KEY, updated);
    } catch (e) {
        console.error(`Failed to update orientation for ${projectId}:`, e);
    }
}

export async function deleteProject(projectId: string): Promise<void> {
    try {
        const projects = await getProjectsList();
        const filtered = projects.filter(p => p.id !== projectId);
        await set(PROJECTS_LIST_KEY, filtered);
        await del(getStoryKey(projectId));
        await del(getActorDbKey(projectId));
    } catch (e) {
        console.error(`Failed to delete project ${projectId}:`, e);
        throw e;
    }
}

/**
 * Persists the current story timeline (including base64 images) to IndexedDB.
 * This prevents the 5MB localStorage quota limit from breaking the app.
 */
export async function saveStoryToStorage(projectId: string, data: StoryGenerationData): Promise<void> {
    try {
        await set(getStoryKey(projectId), data);
        await touchProject(projectId);
    } catch (e) {
        console.error(`Failed to save story to IndexedDB for project ${projectId}:`, e);
    }
}

/**
 * Retrieves the persisted story timeline on initial load.
 */
export async function loadStoryFromStorage(projectId: string): Promise<StoryGenerationData | null> {
    try {
        const data = await get<StoryGenerationData>(getStoryKey(projectId));
        return data || null;
    } catch (e) {
        console.error(`Failed to load story from IndexedDB for project ${projectId}:`, e);
        return null;
    }
}

/**
 * Clears the active story timeline (keeps the project, just empties the beats).
 */
export async function clearStoryStorage(projectId: string): Promise<void> {
    try {
        await del(getStoryKey(projectId));
        await touchProject(projectId);
    } catch (e) {
        console.error(`Failed to clear story from IndexedDB for project ${projectId}:`, e);
    }
}

/**
 * Manages the Actor reference images for Identity Locks (Scoped by Project)
 */
const getActorDbKey = (projectId: string) => `cartoon2d_actors_${projectId}`;

export async function saveActorIdentity(projectId: string, actorId: string, base64Image: string): Promise<void> {
    try {
        const db = await get<Record<string, string>>(getActorDbKey(projectId)) || {};
        db[actorId] = base64Image;
        await set(getActorDbKey(projectId), db);
    } catch (e) {
        console.error(`Failed to save identity for ${actorId}:`, e);
    }
}

export async function loadActorIdentities(projectId: string): Promise<Record<string, string>> {
    try {
        const db = await get<Record<string, string>>(getActorDbKey(projectId));
        return db || {};
    } catch (e) {
        console.error(`Failed to load actors for project ${projectId}:`, e);
        return {};
    }
}
