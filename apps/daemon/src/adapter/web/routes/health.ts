import { Router } from 'express';

export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, phase: 1 });
  });

  return router;
}
