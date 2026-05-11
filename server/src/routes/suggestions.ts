import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSuggestionSchema,
  listSuggestionsQuerySchema,
  measureSuggestionSchema,
  updateSuggestionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, suggestionService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function suggestionRoutes(db: Db) {
  const router = Router();
  const svc = suggestionService(db);

  router.get("/companies/:companyId/suggestions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listSuggestionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    const rows = await svc.list(companyId, parsed.data);
    res.json({ rows });
  });

  router.get("/suggestions/:id", async (req, res) => {
    const row = await svc.getById(req.params.id as string);
    if (!row) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  router.post(
    "/companies/:companyId/suggestions",
    validate(createSuggestionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const row = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "suggestion.created",
        entityType: "suggestion",
        entityId: row.id,
        details: { sequenceLabel: row.sequenceLabel, sourceIssueId: row.sourceIssueId },
      });
      res.status(201).json(row);
    },
  );

  router.patch("/suggestions/:id", validate(updateSuggestionSchema), async (req, res) => {
    const id = req.params.id as string;
    const current = await svc.getById(id);
    if (!current) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    assertCompanyAccess(req, current.companyId);
    const row = await svc.update(id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: current.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "suggestion.updated",
      entityType: "suggestion",
      entityId: id,
      details: { changes: req.body },
    });
    res.json(row);
  });

  router.post(
    "/suggestions/:id/measure",
    validate(measureSuggestionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const current = await svc.getById(id);
      if (!current) {
        res.status(404).json({ error: "Suggestion not found" });
        return;
      }
      assertCompanyAccess(req, current.companyId);
      const row = await svc.measure(id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: current.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "suggestion.measured",
        entityType: "suggestion",
        entityId: id,
        details: { actualValue: req.body.actualValue, outcomeLabel: row?.outcomeLabel },
      });
      res.json(row);
    },
  );

  router.get("/companies/:companyId/suggestions/due", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listDue(companyId);
    res.json({ rows });
  });

  return router;
}
