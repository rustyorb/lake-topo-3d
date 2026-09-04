import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { MIDWESTERN_LAKES } from './server/lakeData.js';
import { generateLakeTerrainGrid } from './server/lakeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Get curated Midwestern lakes list
  app.get('/api/lakes', (req, res) => {
    const lakes = MIDWESTERN_LAKES.map((l) => ({
      id: l.metadata.id,
      name: l.metadata.name,
      state: l.metadata.state,
      county: l.metadata.county,
      areaAcres: l.metadata.areaAcres,
      maxDepthFt: l.metadata.maxDepthFt,
      surfaceElevationFt: l.metadata.surfaceElevationFt,
      geologicalOrigin: l.metadata.geologicalOrigin,
      description: l.metadata.description,
    }));
    res.json(lakes);
  });

  // Search or generate 3D topography and bathymetry grid for any Midwestern lake
  app.get('/api/lake-terrain', async (req, res) => {
    try {
      const query = (req.query.q as string) || 'Deam Lake, Indiana';
      const gridSize = parseInt((req.query.gridSize as string) || '64', 10);
      const forceAiRecon = req.query.forceAiRecon === 'true';
      const userNotes = (req.query.userNotes as string) || undefined;
      const data = await generateLakeTerrainGrid(query, gridSize, { forceAiRecon, userNotes });
      res.json(data);
    } catch (err: any) {
      console.error('Error generating lake terrain:', err);
      res.status(500).json({ error: err.message || 'Failed to generate lake terrain' });
    }
  });

  app.post('/api/lake-terrain', async (req, res) => {
    try {
      const { query, gridSize, forceAiRecon, userNotes, uploadedImage } = req.body;
      const targetQuery = query || 'Deam Lake, Indiana';
      const size = gridSize ? parseInt(gridSize, 10) : 64;
      const data = await generateLakeTerrainGrid(targetQuery, size, {
        forceAiRecon: Boolean(forceAiRecon),
        userNotes,
        uploadedImage,
      });
      res.json(data);
    } catch (err: any) {
      console.error('Error generating lake terrain:', err);
      res.status(500).json({ error: err.message || 'Failed to generate lake terrain' });
    }
  });

  // Generatively analyze an uploaded Topo Map or Bathymetric Survey chart
  app.post('/api/analyze-topo-image', async (req, res) => {
    try {
      const { imageBase64, mimeType, query, gridSize } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: 'Missing imageBase64 in request' });
      }
      const size = gridSize ? parseInt(gridSize, 10) : 64;
      const data = await generateLakeTerrainGrid(query || 'Uploaded Topo Lake', size, {
        uploadedImage: {
          base64: imageBase64,
          mimeType: mimeType || 'image/png',
        },
      });
      res.json(data);
    } catch (err: any) {
      console.error('Error analyzing topo map image:', err);
      res.status(500).json({ error: err.message || 'Failed to analyze topo map image' });
    }
  });

  // Explicit AI Topo Reconnaissance endpoint with Google Search grounding
  app.post('/api/ai-topo-recon', async (req, res) => {
    try {
      const { query, userNotes, gridSize } = req.body;
      const targetQuery = query || 'Deam Lake, Indiana';
      const size = gridSize ? parseInt(gridSize, 10) : 64;
      const data = await generateLakeTerrainGrid(targetQuery, size, {
        forceAiRecon: true,
        userNotes,
      });
      res.json(data);
    } catch (err: any) {
      console.error('Error during AI Topo Recon:', err);
      res.status(500).json({ error: err.message || 'AI Topo Recon failed' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Lake 3D Topo server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
