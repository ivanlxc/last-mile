import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "../../server/core/store.js";
import {
  createGameService,
  type GameService,
} from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";

const url = process.env.PG_TEST_URL;
describe.skipIf(!url)("PostgreSQL shared playtest lifecycle", () => {
  it("isolates five players, scopes retry keys, enforces admission, and preserves owned history across restart", async () => {
    const admin = new Client({ connectionString: url });
    await admin.connect();
    const database = `last_mile_gameplay_${randomUUID().replaceAll("-", "")}`;
    const endpoint = new URL(url!);
    endpoint.pathname = `/${database}`;
    let store: Store | undefined;
    let service: GameService | undefined;
    let time = 0;
    const cloud = {
      maxActiveSessions: 5,
      maxSessionsPerPlayerPerDay: 3,
      maxModelAttemptsPerDay: 100,
      maxConcurrentModelJobs: 2,
    };
    const start = async () => {
      store = await createStore({ databaseUrl: endpoint.href });
      service = await createGameService({
        store,
        cloud,
        agents: createAiService({ env: {} }),
        clock: { nowMs: () => 1800000000000 + time, monotonicMs: () => time },
        selectCase: () => "A",
      });
      return service;
    };
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      await start();
      const players = Array.from({ length: 6 }, () => randomUUID());
      for (const player of players)
        await store!.insert("cloud_players", {
          player_id: player,
          created_at_ms: 1800000000000,
        });
      const boot = (await service!.read("getBootstrap")) as P.BootstrapView;
      const body = {
        profileId: "SINGLE_PLAYER_REFERENCE",
        runPurpose: "design_preview",
        locale: "en-US",
        contentVersionId: boot.profiles[0]!.contentVersionId,
      };
      // The exact same client-supplied request UUID is valid for different owners.
      const requestKey = randomUUID();
      const made = await Promise.all(
        players.slice(0, 5).map(async (playerId) => {
          const response = await service!.executeWithMeta(
            "createSession",
            body,
            { playerId, idempotencyKey: requestKey },
          );
          expect(response.replayed).toBe(false);
          return response.result as P.SessionCreated;
        }),
      );
      expect(new Set(made.map((s) => s.sessionId)).size).toBe(5);
      await expect(
        service!.execute("createSession", body, {
          playerId: players[5],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 429 });
      const retry = await service!.executeWithMeta("createSession", body, {
        playerId: players[0],
        idempotencyKey: requestKey,
      });
      expect(retry.replayed).toBe(true);
      expect((retry.result as P.SessionCreated).sessionId).toBe(
        made[0]!.sessionId,
      );
      for (let i = 0; i < 5; i++) {
        expect(
          await service!.hasPlayerSessionAccess(
            made[i]!.sessionId,
            players[i]!,
          ),
        ).toBe(true);
        expect(
          await service!.hasPlayerSessionAccess(
            made[i]!.sessionId,
            players[(i + 1) % 5]!,
          ),
        ).toBe(false);
      }
      await Promise.all(
        made.map(async (session, i) => {
          const p = (await service!.read(
            "getSession",
            session.sessionId,
          )) as P.SessionProjection;
          await service!.execute(
            "startSession",
            {
              expectedStateVersion: p.stateVersion,
              expectedSceneId: p.sceneId,
              payload: { acknowledgeDesignPreview: true },
            },
            {
              playerId: players[i],
              sessionId: session.sessionId,
              runEpoch: p.runEpoch,
              idempotencyKey: randomUUID(),
            },
          );
        }),
      );
      time += 30000;
      await service!.tick();
      for (const session of made) {
        const p = (await service!.read(
          "getSession",
          session.sessionId,
        )) as P.SessionProjection;
        expect(p.sceneId).toBe("E1");
        expect(
          p.resources.find((r) => r.channel === "satellite")!.remaining,
        ).toBe(2);
      }
      const p = (await service!.read(
        "getSession",
        made[0]!.sessionId,
      )) as P.SessionProjection;
      await expect(
        service!.execute(
          "abandonSession",
          {
            expectedStateVersion: p.stateVersion,
            expectedSceneId: p.sceneId,
            payload: { reason: "player_exit" },
          },
          {
            playerId: players[1],
            sessionId: p.sessionId,
            runEpoch: p.runEpoch,
            idempotencyKey: randomUUID(),
          },
        ),
      ).rejects.toMatchObject({ status: 404 });
      await service!.close();
      service = undefined;
      store = undefined;
      await start();
      for (let i = 0; i < 5; i++) {
        const history = await service!.listPlayerSessions(players[i]!);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          sessionId: made[i]!.sessionId,
          status: "sealed",
        });
        expect(
          await service!.hasPlayerSessionAccess(
            made[i]!.sessionId,
            players[i]!,
          ),
        ).toBe(true);
        expect(
          await service!.hasPlayerSessionAccess(
            made[i]!.sessionId,
            players[(i + 1) % 5]!,
          ),
        ).toBe(false);
        const recovered = (await service!.read(
          "getSession",
          made[i]!.sessionId,
        )) as P.SessionProjection;
        expect(recovered.lifecycle).toBe("sealed");
      }
      const retryAfterRestart = await service!.executeWithMeta(
        "createSession",
        body,
        { playerId: players[0], idempotencyKey: requestKey },
      );
      expect(retryAfterRestart.replayed).toBe(true);
      expect((retryAfterRestart.result as P.SessionCreated).sessionId).toBe(
        made[0]!.sessionId,
      );
    } finally {
      await service?.close();
      await store?.close();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  }, 60000);
});
