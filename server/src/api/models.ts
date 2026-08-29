/**
 * REST routes for model listing.
 *
 * Delegates to the active BackendAdapter so each provider handles
 * model discovery in its own way (OpenAI /v1/models, OpenRouter cache,
 * hardcoded lists for Claude/Gemini, etc.).
 */

import { Router } from 'express';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { SecretService } from '../services/SecretService.js';
import { createBackendAdapter, buildAdapterFactoryInput } from '../backends/factory.js';
import { customBackendSelectionFromSettings } from '../backends/customBackendFactory.js';
import type { BackendAdapter } from '../backends/BackendAdapter.js';
import { buildBackendSettings } from '../backends/buildBackendSettings.js';
import { resolveSecretSettings } from '../services/SecretResolver.js';
import { OpenRouterModelCache } from '../backends/OpenRouterModelCache.js';
import { apiError, ApiError } from '../middleware/errorHandler.js';

export function createModelsRouter(
  settingsRepo: ISettingsRepository,
  backendConfigRepo: IBackendConfigRepository,
  secretService: SecretService,
  secretsPassword: string,
  /** Optional: resolves Lua-driven custom backends (provider `custom`). */
  createResolvedAdapter?: (settings: Record<string, unknown>) => Promise<BackendAdapter | null>,
) {
  const router = Router();
  const openRouterCache = new OpenRouterModelCache();

  /**
   * GET /api/models
   *
   * Returns models from the currently configured provider's adapter.
   */
  router.get('/', async (_req, res) => {
    try {
      const settings = { ...(await settingsRepo.list()) };
      const activeBackendConfigId = String(settings['activeBackendConfigId']);
      const backendConfig = activeBackendConfigId ? await backendConfigRepo.getById(activeBackendConfigId) : null;
      const backendSettings = buildBackendSettings(settings, backendConfig);
      await resolveSecretSettings(backendSettings, secretService, secretsPassword);
      const adapter =
        customBackendSelectionFromSettings(backendSettings) && createResolvedAdapter
          ? await createResolvedAdapter(backendSettings)
          : createBackendAdapter(buildAdapterFactoryInput(backendSettings), true);
      if (!adapter) {
        res.json({ items: [], total: 0 });
        return;
      }
      const models = await adapter.listModels();
      res.json({ items: models, total: models.length });
    } catch (err) {
      // Upstream failure → 502 (not a generic 500); the central handler logs the cause.
      throw apiError('MODELS_FETCH_FAILED', 'Failed to fetch models', 502, { cause: err });
    }
  });

  /**
   * GET /api/models/openrouter/:id
   *
   * OpenRouter-specific model detail (kept for backward compat).
   */
  router.get('/openrouter/:id', async (req, res) => {
    try {
      const model = await openRouterCache.getModel(req.params.id);
      if (!model) {
        throw apiError('NOT_FOUND', 'Model not found', 404);
      }
      res.json(model);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw apiError('MODEL_FETCH_FAILED', 'Failed to fetch model', 502, { details: message, cause: err });
    }
  });

  /**
   * GET /api/models/openrouter/:id/providers
   *
   * OpenRouter-specific provider list (kept for backward compat).
   */
  router.get('/openrouter/:id/providers', async (req, res) => {
    try {
      const providers = await openRouterCache.listProviders(req.params.id);
      res.json({ items: providers, total: providers.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw apiError('PROVIDERS_FETCH_FAILED', 'Failed to fetch providers', 502, { details: message, cause: err });
    }
  });

  return router;
}
