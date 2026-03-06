import fs from "fs/promises";
import path from "path";
import { Actor, ActorSchema } from "../schema/actor";
import { StoryScene, StorySceneSchema } from "../schema/story";

const DATA_DIR = path.join(process.cwd(), "data");
const ACTORS_DIR = path.join(DATA_DIR, "characters");
const SCENES_DIR = path.join(DATA_DIR, "scenes");

// Ensure directories exist
async function ensureDirs() {
    await fs.mkdir(ACTORS_DIR, { recursive: true });
    await fs.mkdir(SCENES_DIR, { recursive: true });
}

export async function saveActor(actor: Actor): Promise<void> {
    await ensureDirs();
    const actorPath = path.join(ACTORS_DIR, `${actor.id}.json`);
    await fs.writeFile(actorPath, JSON.stringify(actor, null, 2), "utf-8");
}

export async function loadActor(id: string): Promise<Actor | null> {
    try {
        const actorPath = path.join(ACTORS_DIR, `${id}.json`);
        const data = await fs.readFile(actorPath, "utf-8");
        const json = JSON.parse(data);
        return ActorSchema.parse(json);
    } catch (error) {
        console.error(`Failed to load actor ${id}:`, error);
        return null;
    }
}

export async function saveScene(scene: StoryScene): Promise<void> {
    await ensureDirs();
    const scenePath = path.join(SCENES_DIR, `${scene.id}.json`);
    await fs.writeFile(scenePath, JSON.stringify(scene, null, 2), "utf-8");
}

export async function loadScene(id: string): Promise<StoryScene | null> {
    try {
        const scenePath = path.join(SCENES_DIR, `${id}.json`);
        const data = await fs.readFile(scenePath, "utf-8");
        const json = JSON.parse(data);
        return StorySceneSchema.parse(json);
    } catch (error) {
        console.error(`Failed to load scene ${id}:`, error);
        return null;
    }
}

export async function listActors(): Promise<Actor[]> {
    await ensureDirs();
    const files = await fs.readdir(ACTORS_DIR);
    const actors: Actor[] = [];

    for (const file of files) {
        if (file.endsWith('.json')) {
            const id = file.replace('.json', '');
            const actor = await loadActor(id);
            if (actor) actors.push(actor);
        }
    }
    return actors;
}

export async function listScenes(): Promise<StoryScene[]> {
    await ensureDirs();
    const files = await fs.readdir(SCENES_DIR);
    const scenes: StoryScene[] = [];

    for (const file of files) {
        if (file.endsWith('.json')) {
            const id = file.replace('.json', '');
            const scene = await loadScene(id);
            if (scene) scenes.push(scene);
        }
    }
    return scenes;
}
