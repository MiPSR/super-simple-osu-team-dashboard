import type { GameMode } from "@osu-team/contracts";
import type { Queries, UpsertMemberInput, TeamRow } from "@osu-team/database";
import { nowIso } from "@osu-team/database";
import { rulesetIdToModeName, type OsuClient, type TeamJson, type Logger } from "./osu.ts";
import { userToMemberInput } from "./mapping.ts";

/**
 * Team synchronization (spec 3.1): fetch the configured team at startup and at
 * each hourly collection. Membership changes become effective upon successful
 * synchronization; removed players stop receiving snapshots (3.12) but keep
 * their stored history.
 */
export class TeamRoster {
  private rosterIds = new Set<number>();

  constructor(
    private readonly client: OsuClient,
    private readonly queries: Queries,
    private readonly teamId: number,
    private readonly logger: Logger,
  ) {}

  get size(): number {
    return this.rosterIds.size;
  }

  has(userId: number): boolean {
    return this.rosterIds.has(userId);
  }

  ids(): number[] {
    return Array.from(this.rosterIds);
  }

  /** Fetch and apply the roster; throws on API failure (caller decides policy). */
  async sync(): Promise<TeamRow> {
    const team = await this.client.getTeam(this.teamId);
    const syncedAt = nowIso();
    const defaultMode = (rulesetIdToModeName(team.default_ruleset_id) ?? "osu") as GameMode;

    const memberInputs: UpsertMemberInput[] = [];
    const ids: number[] = [];
    if (team.leader) {
      memberInputs.push(userToMemberInput(team.leader));
      ids.push(team.leader.id);
    }
    for (const member of team.members ?? []) {
      memberInputs.push(userToMemberInput(member));
      ids.push(member.id);
    }

    this.queries.transaction(() => {
      this.queries.upsertTeam(
        {
          id: team.id,
          name: team.name,
          shortName: team.short_name,
          flagUrl: team.flag_url ?? null,
          coverUrl: team.cover_url ?? null,
          defaultMode,
          syncedAt,
        },
      );
      this.queries.upsertMembers(memberInputs, syncedAt);
      this.queries.deactivateAbsentMembers(ids);
      this.queries.markTeamSynced(syncedAt);
    });
    this.rosterIds = new Set(ids);
    this.logger.info(`team sync ok: "${team.name}" (${ids.length} members, default mode ${defaultMode})`);
    return this.queries.getTeam() as TeamRow;
  }

  /** Restore the roster from the database after a restart (3.4). */
  loadFromDatabase(): void {
    this.rosterIds = new Set(this.queries.getActiveMemberIds());
    this.logger.info(`roster restored from database: ${this.rosterIds.size} active members`);
  }

  static teamToRow(team: TeamJson, defaultMode: GameMode, syncedAt: string): TeamRow {
    return {
      id: team.id,
      name: team.name,
      shortName: team.short_name,
      flagUrl: team.flag_url ?? null,
      coverUrl: team.cover_url ?? null,
      defaultMode,
      syncedAt,
    };
  }
}
