import { db } from "./db";
import {
  projects,
  tools,
  type InsertProject,
  type Project,
  type InsertTool,
  type Tool,
} from "@shared/schema";
import { eq } from "drizzle-orm";

export interface IStorage {
  // Projects
  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProject(id: number, updates: Partial<InsertProject>): Promise<Project>;
  deleteProject(id: number): Promise<void>;

  // Tools
  getTools(): Promise<Tool[]>;
  getToolByNumber(toolNumber: number): Promise<Tool | undefined>;
  createTool(tool: InsertTool): Promise<Tool>;
  updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool>;
  deleteTool(id: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  // Projects
  async getProjects(): Promise<Project[]> {
    return await db.select().from(projects).orderBy(projects.createdAt);
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  async createProject(insertProject: InsertProject): Promise<Project> {
    const [project] = await db.insert(projects).values(insertProject).returning();
    return project;
  }

  async updateProject(id: number, updates: Partial<InsertProject>): Promise<Project> {
    const [project] = await db
      .update(projects)
      .set(updates)
      .where(eq(projects.id, id))
      .returning();
    return project;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  // Tools
  async getTools(): Promise<Tool[]> {
    return await db.select().from(tools).orderBy(tools.toolNumber);
  }

  async getToolByNumber(toolNumber: number): Promise<Tool | undefined> {
    const [tool] = await db.select().from(tools).where(eq(tools.toolNumber, toolNumber));
    return tool;
  }

  async createTool(insertTool: InsertTool): Promise<Tool> {
    const [tool] = await db.insert(tools).values(insertTool).returning();
    return tool;
  }

  async updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool> {
    const [tool] = await db
      .update(tools)
      .set(updates)
      .where(eq(tools.id, id))
      .returning();
    return tool;
  }

  async deleteTool(id: number): Promise<void> {
    await db.delete(tools).where(eq(tools.id, id));
  }
}

export const storage = new DatabaseStorage();
