import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { MIDWESTERN_LAKES } from './server/lakeData.js';
import { clearTerrainCache, generateLakeTerrainGrid, llmAvailable, llmDescription } from './server/lakeService.js';
import { geodataEnabled, lookupLakeOSM } from './server/geoData.js';

const DEFAULT_QUERY = 'Deam Lake, Indiana';

function parseGrid(v: unknown, fallback = 72): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function startServer() {
  const app = express();
  const basePort = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      llm: llmDescription(),
      geodata: geodataEnabled(),
    });
  });

  // Curated lake registry (metadata only)
  app.get('/api/lakes', (_req, res) => {
    res.json(
      MIDWESTERN_LAKES.map((l) => ({
        id: l.metadata.id,
        name: l.metadata.name,
        state: l.metadata.state,
        county: l.metadata.county,
        areaAcres: l.metadata.areaAcres,
        maxDepthFt: l.metadata.maxDepthFt,
        surfaceElevationFt: l.metadata.surfaceElevationFt,
        geologicalOrigin: l.metadata.geologicalOrigin,
        description: l.metadata.description,
      }))
    );
  });

  // Quick shoreline lookup (no terrain) — useful for autocomplete / "did it find my lake?"
  app.get('/api/lookup', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q' });
    const osm = await lookupLakeOSM(q);
    if (!osm) return res.json({ found: false });
    res.json({
      found: true,
      name: osm.name,
      displayName: osm.displayName,
      lat: osm.lat,
      lon: osm.lon,
      areaAcres: Math.round(osm.areaKm2 * 247.105),
      perimeterKm: Math.round(osm.perimeterKm * 10) / 10,
      osm: `${osm.osmType}/${osm.osmId}`,
    });
  });

  // Terrain grid for any named lake
  app.get('/api/lake-terrain', async (req, res) => {
    try {
      const query = String(req.query.q || DEFAULT_QUERY);
      const data = await generateLakeTerrainGrid(query, parseGrid(req.query.gridSize), {
        forceAiRecon: req.query.forceAiRecon === 'true',
        userNotes: req.query.userNotes ? String(req.query.userNotes) : undefined,
        skipGeodata: req.query.offline === 'true',
      });
      res.json(data);
    } catch (err: any) {
      console.error('Error generating lake terrain:', err);
      res.status(500).json({ error: err.message || 'Failed to generate lake terrain' });
    }
  });

  app.post('/api/lake-terrain', async (req, res) => {
    try {
      const { query, gridSize, forceAiRecon, userNotes, uploadedImage, offline } = req.body || {};
      const data = await generateLakeTerrainGrid(query || DEFAULT_QUERY, parseGrid(gridSize), {
        forceAiRecon: Boolean(forceAiRecon),
        userNotes,
        uploadedImage,
        skipGeodata: Boolean(offline),
      });
      res.json(data);
    } catch (err: any) {
      console.error('Error generating lake terrain:', err);
      res.status(500).json({ error: err.message || 'Failed to generate lake terrain' });
    }
  });

  // Gemini Vision analysis of an uploaded topo / bathymetric chart image
  app.post('/api/analyze-topo-image', async (req, res) => {
    try {
      const { imageBase64, mimeType, query, gridSize } = req.body || {};
      if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64 in request' });
      if (!llmAvailable()) return res.status(503).json({ error: 'No LLM provider configured (set LLM_PROVIDER / an API key); chart analysis is unavailable.' });
      const data = await generateLakeTerrainGrid(query || 'Uploaded Topo Lake', parseGrid(gridSize), {
        uploadedImage: { base64: imageBase64, mimeType: mimeType || 'image/png' },
      });
      res.json(data);
    } catch (err: any) {
      console.error('Error analyzing topo map image:', err);
      res.status(500).json({ error: err.message || 'Failed to analyze topo map image' });
    }
  });

  // Explicit AI recon with Google Search grounding
  app.post('/api/ai-topo-recon', async (req, res) => {
    try {
      const { query, userNotes, gridSize } = req.body || {};
      if (!llmAvailable()) return res.status(503).json({ error: 'No LLM provider configured (set LLM_PROVIDER / an API key); AI recon is unavailable.' });
      const data = await generateLakeTerrainGrid(query || DEFAULT_QUERY, parseGrid(gridSize), { forceAiRecon: true, userNotes });
      res.json(data);
    } catch (err: any) {
      console.error('Error during AI Topo Recon:', err);
      res.status(500).json({ error: err.message || 'AI Topo Recon failed' });
    }
  });

  app.post('/api/cache/clear', (_req, res) => {
    clearTerrainCache();
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // Probe upward if the port is busy (common when several local apps run at once)
  const listen = (port: number, attemptsLeft: number) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`lake-topo-3d listening on http://localhost:${port}  (llm: ${llmDescription().provider}${llmAvailable() ? '/' + llmDescription().model : ''}, geodata: ${geodataEnabled() ? 'on' : 'off'})`);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        console.warn(`port ${port} in use, trying ${port + 1}`);
        listen(port + 1, attemptsLeft - 1);
      } else {
        throw err;
      }
    });
  };
  listen(basePort, 10);
}

startServer();
