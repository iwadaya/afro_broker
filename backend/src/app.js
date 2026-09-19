import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

import authRoutes from './modules/auth/auth.routes.js';
import registerRoutes from './modules/register/register.routes.js';
import marketRoutes from './modules/markets/markets.routes.js';
import placementRoutes from './modules/placements/placements.routes.js';
import layerRoutes from './modules/placements/layers.routes.js';
import bordereauxRoutes from './modules/bordereaux/bordereaux.routes.js';
import packRoutes from './modules/packs/packs.routes.js';
import marketingRoutes from './modules/marketing/marketing.routes.js';
import fotRoutes from './modules/fot/fot.routes.js';
import lineRoutes from './modules/lines/lines.routes.js';
import signingRoutes from './modules/signing/signing.routes.js';
import documentRoutes from './modules/documents/documents.routes.js';
import contractDocumentRoutes from './modules/documents/contractDocuments.routes.js';
import amendmentRoutes from './modules/amendments/amendments.routes.js';
import wordingRoutes from './modules/wordings/wordings.routes.js';
import occupancyClassRoutes from './modules/retentions/occupancyClasses.routes.js';
import lookupRoutes from './modules/refdata/lookups.routes.js';
import modellingRoutes from './modules/modelling/modelling.routes.js';
import negotiationRoutes from './modules/negotiation/negotiation.routes.js';
import outlookRoutes from './modules/negotiation/outlook.routes.js';
import finalRoutes from './modules/final/final.routes.js';
import dashboardRoutes from './modules/dashboards/dashboards.routes.js';
import portfolioRoutes from './modules/dashboards/portfolio.routes.js';
import servicingRoutes from './modules/dashboards/servicing.routes.js';
import marketIntelligenceRoutes from './modules/intelligence/marketIntelligence.routes.js';
import dfaRoutes from './modules/dfa/dfa.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

// §1.1 — the spine: Cedant -> Contract -> ContractYear.
import contractRoutes from './modules/spine/contracts.routes.js';
import contractYearRoutes from './modules/spine/contract-years.routes.js';
import structureRoutes from './modules/spine/structures.routes.js';
import responseRoutes from './modules/spine/responses.routes.js';
import clientCycleRoutes from './modules/spine/clientCycle.routes.js';
import distributionRoutes from './modules/spine/distribution.routes.js';
import spineLineRoutes from './modules/spine/lines.routes.js';
import spineDashboardRoutes from './modules/spine/dashboard.routes.js';
import approvalRoutes from './modules/spine/approvals.routes.js';
import ingestRoutes from './modules/ingest/ingest.routes.js';
import analysisRoutes from './modules/analysis/analysis.routes.js';
import renewalPackAnalysisRoutes from './modules/analysis/renewalPack.routes.js';
import placementDataRoutes from './modules/analysis/placementData.routes.js';
import mdpRoutes from './modules/mdp/mdp.routes.js';
import premiumRoutes from './modules/premium/premium.routes.js';
import claimsRoutes from './modules/claims/claims.routes.js';
import claimsWorkspaceRoutes from './modules/claims/claimsWorkspace.routes.js';
import claimNotificationRoutes from './modules/claims/claimNotifications.routes.js';

/**
 * CORS policy. Development stays wide open so the Vite dev server on :5173 can
 * talk to the API on :4000. Production is same-origin by default (one service
 * serves both), and only the origins named in CORS_ORIGINS are allowed through.
 */
function corsMiddleware() {
  if (config.corsOrigins.length) {
    return cors({ origin: config.corsOrigins, credentials: true });
  }
  if (config.isProd) return null;
  return cors();
}

/**
 * Serve the built SPA alongside the API so a single process/origin covers the
 * whole app. Unknown non-API paths fall through to index.html for client-side
 * routing; unknown /api paths have already returned a JSON 404 by this point.
 */
function mountStatic(app) {
  const indexHtml = path.join(config.static.dir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    console.warn(`SERVE_STATIC is on but no frontend build at ${config.static.dir} — skipping.`);
    return;
  }
  app.use(
    express.static(config.static.dir, {
      index: false,
      setHeaders(res, filePath) {
        // Vite emits content-hashed filenames under assets/, so those can be
        // cached indefinitely; everything else must be revalidated.
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  // index.html must never be cached: it names the hashed asset bundles, so a
  // stale copy would keep pointing browsers at the previous deploy's files.
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}

export function createApp() {
  const app = express();
  // Behind a PaaS load balancer, req.ip is the proxy unless we trust it — and
  // the login limiter buckets by req.ip.
  if (config.trustProxy) app.set('trust proxy', 1);
  const crossOrigin = corsMiddleware();
  if (crossOrigin) app.use(crossOrigin);
  // 25mb: uploaded bordereau files travel as base64 in the JSON body.
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'universe-broking' }));

  // Auth + the counterparty register (markets and cedants).
  app.use('/api/auth', authRoutes);
  app.use('/api', registerRoutes);
  app.use('/api', marketRoutes);

  // Placement lifecycle.
  app.use('/api/placements', placementRoutes);
  app.use('/api/layers', layerRoutes);

  // Data, packs, marketing, FOT, lines, documents — these routers declare their
  // own resource-rooted paths (e.g. /layers/:id/lines), so mount at /api.
  app.use('/api', bordereauxRoutes);
  // Modelling workflow on the placement page (per-screen section store).
  app.use('/api', modellingRoutes);
  app.use('/api/ingest', ingestRoutes);
  app.use('/api', analysisRoutes);
  app.use('/api', renewalPackAnalysisRoutes);
  // The Data screen: the placement's screens read as one, against the prior year.
  app.use('/api', placementDataRoutes);
  app.use('/api', mdpRoutes);
  app.use('/api', premiumRoutes);
  app.use('/api', claimsRoutes);
  app.use('/api', claimsWorkspaceRoutes);
  app.use('/api', claimNotificationRoutes);
  app.use('/api', packRoutes);
  app.use('/api', marketingRoutes);
  app.use('/api', fotRoutes);
  app.use('/api', lineRoutes);
  // Signing by contract: which contract, then its programme and its signings.
  app.use('/api', signingRoutes);
  app.use('/api', documentRoutes);
  // The Documents step under Contracts: files uploaded against a contract.
  app.use('/api', contractDocumentRoutes);
  app.use('/api', amendmentRoutes);
  app.use('/api', wordingRoutes);
  app.use('/api', occupancyClassRoutes);
  // Reference data lookups behind the Treaty Detail dropdowns (the modelling
  // tool's lookups: brokers, treaty types, classes of business, ref lists).
  app.use('/api', lookupRoutes);
  app.use('/api', negotiationRoutes);
  // The Outlook mailbox the submissions go out from and the replies come back into.
  app.use('/api', outlookRoutes);
  // Final placement: final terms, firm order terms, written and signed lines.
  app.use('/api', finalRoutes);

  // The spine (§1.1).
  app.use('/api', contractRoutes);
  app.use('/api', contractYearRoutes);
  app.use('/api', structureRoutes);
  app.use('/api', responseRoutes);
  app.use('/api', clientCycleRoutes);
  app.use('/api', distributionRoutes);
  app.use('/api', spineLineRoutes);
  app.use('/api', spineDashboardRoutes);
  app.use('/api', approvalRoutes);

  // Dynamic financial analysis — what-if over the book.
  app.use('/api', dfaRoutes);

  // Dashboards + admin.
  app.use('/api/dashboards', dashboardRoutes);
  // Portfolio intelligence — who leads, who places and who writes the book.
  app.use('/api/dashboards', portfolioRoutes);
  app.use('/api/dashboards', servicingRoutes);
  // Market intelligence — a market by country or region: the book there, the
  // AI's research of the internet, and the brokers' own visits and notes.
  app.use('/api/market-intelligence', marketIntelligenceRoutes);
  app.use('/api/admin', adminRoutes);

  // Unknown API routes stay JSON even when the SPA fallback is mounted below.
  app.use('/api', notFoundHandler);

  if (config.static.enabled) mountStatic(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

