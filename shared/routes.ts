import { z } from 'zod';
import { insertProjectSchema, insertToolSchema, projects, tools, settings } from './schema';

// ============================================
// SHARED ERROR SCHEMAS
// ============================================
export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

// ============================================
// API CONTRACT
// ============================================
export const api = {
  projects: {
    list: {
      method: 'GET' as const,
      path: '/api/projects',
      responses: {
        200: z.array(z.custom<typeof projects.$inferSelect>()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/projects/:id',
      responses: {
        200: z.custom<typeof projects.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/projects',
      input: insertProjectSchema,
      responses: {
        201: z.custom<typeof projects.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/projects/:id',
      input: insertProjectSchema.partial(),
      responses: {
        200: z.custom<typeof projects.$inferSelect>(),
        404: errorSchemas.notFound,
        400: errorSchemas.validation,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/projects/:id',
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
    generateGCode: {
      method: 'POST' as const,
      path: '/api/projects/:id/gcode',
      responses: {
        200: z.object({ gcode: z.string() }),
        404: errorSchemas.notFound,
      },
    }
  },
  tools: {
    list: {
      method: 'GET' as const,
      path: '/api/tools',
      responses: {
        200: z.array(z.custom<typeof tools.$inferSelect>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/tools',
      input: insertToolSchema,
      responses: {
        201: z.custom<typeof tools.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/tools/:id',
      input: insertToolSchema.partial(),
      responses: {
        200: z.custom<typeof tools.$inferSelect>(),
        404: errorSchemas.notFound,
        400: errorSchemas.validation,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/tools/:id',
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
  },
  settings: {
    list: {
      method: 'GET' as const,
      path: '/api/settings',
      responses: {
        200: z.array(z.custom<typeof settings.$inferSelect>()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/settings/:key',
      responses: {
        200: z.custom<typeof settings.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    upsert: {
      method: 'PUT' as const,
      path: '/api/settings/:key',
      input: z.object({ value: z.any() }),
      responses: {
        200: z.custom<typeof settings.$inferSelect>(),
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/settings/:key',
      responses: {
        204: z.void(),
      },
    },
  },
};

// ============================================
// HELPER
// ============================================
export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

// ============================================
// TYPE EXPORTS
// ============================================
export type ProjectInput = z.infer<typeof api.projects.create.input>;
export type ToolInput = z.infer<typeof api.tools.create.input>;
