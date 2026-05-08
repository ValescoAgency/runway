import { LinearClient } from "@linear/sdk";
import type { Config } from "./config.js";

/**
 * Trimmed-down view of a Linear issue — just what runway's loop needs.
 * Resolved up-front so the orchestrator doesn't have to round-trip the
 * SDK for every field.
 */
export interface RunwayIssue {
  readonly id: string;
  readonly identifier: string; // "VA-123"
  readonly title: string;
  readonly description: string;
}

export interface LinearGateway {
  fetchReady(): Promise<RunwayIssue[]>;
  transition(issueId: string, statusName: string): Promise<void>;
  applyLabel(issueId: string, labelName: string): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;
}

/**
 * Concrete @linear/sdk-backed implementation. Tests inject their own
 * gateway; never reach for the SDK directly outside this file.
 */
export function createLinearGateway(config: Config): LinearGateway {
  const client = new LinearClient({ apiKey: config.linearApiKey });

  async function findStateId(teamId: string, name: string): Promise<string> {
    const states = await client.workflowStates({
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    const state = states.nodes[0];
    if (!state) {
      throw new Error(
        `Linear workflow state "${name}" not found on team ${teamId}`,
      );
    }
    return state.id;
  }

  async function findTeamId(): Promise<string> {
    const teams = await client.teams({
      filter: { key: { eq: config.linearTeam } },
    });
    const team = teams.nodes[0];
    if (!team) {
      throw new Error(`Linear team "${config.linearTeam}" not found`);
    }
    return team.id;
  }

  return {
    async fetchReady() {
      const teamId = await findTeamId();
      const readyStateId = await findStateId(teamId, config.readyStatus);
      const issues = await client.issues({
        filter: {
          team: { id: { eq: teamId } },
          state: { id: { eq: readyStateId } },
        },
        // Stable order: oldest first so the queue drains FIFO.
        orderBy: "createdAt" as never,
      });
      return issues.nodes.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        description: i.description ?? "",
      }));
    },

    async transition(issueId, statusName) {
      const issue = await client.issue(issueId);
      const team = await issue.team;
      if (!team) throw new Error(`Issue ${issueId} has no team`);
      const stateId = await findStateId(team.id, statusName);
      await client.updateIssue(issueId, { stateId });
    },

    async applyLabel(issueId, labelName) {
      const issue = await client.issue(issueId);
      const team = await issue.team;
      if (!team) throw new Error(`Issue ${issueId} has no team`);
      const labels = await client.issueLabels({
        filter: {
          team: { id: { eq: team.id } },
          name: { eq: labelName },
        },
      });
      const label = labels.nodes[0];
      if (!label) {
        throw new Error(
          `Linear label "${labelName}" not found on team ${team.id}`,
        );
      }
      const existing = await issue.labels();
      const labelIds = [
        ...existing.nodes.map((l) => l.id),
        label.id,
      ];
      await client.updateIssue(issueId, { labelIds });
    },

    async comment(issueId, body) {
      await client.createComment({ issueId, body });
    },
  };
}
