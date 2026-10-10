import Foundation

extension G0Transport {
  public struct WorkspaceQuery: Encodable, Sendable {
    public enum Action: String, Codable, Sendable { case list, file, diff, status }
    public let action: Action
    let cwd: String
    public let path: String?
    let cursor: String?
    let offset: Int?
    let snapshot: String?
    let providerId: String?
    let externalSessionId: String?
    let agentProfileId: String?
    public init(action: Action, cwd: String, path: String? = nil, cursor: String? = nil,
                offset: Int? = nil, snapshot: String? = nil, providerId: String? = nil,
                externalSessionId: String? = nil, agentProfileId: String? = nil) {
      self.action = action; self.cwd = cwd; self.path = path; self.cursor = cursor
      self.offset = offset; self.snapshot = snapshot; self.providerId = providerId
      self.externalSessionId = externalSessionId; self.agentProfileId = agentProfileId
    }
  }
  public struct WorkspaceEntry: Decodable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case file, directory }
    public let name: String
    public let path: String
    public let kind: Kind
    public var id: String { path }
  }
  public struct WorkspaceListing: Decodable, Sendable {
    public let entries: [WorkspaceEntry]
    public let truncated: Bool
    public let nextCursor: String?
  }
  public struct WorkspaceFile: Decodable, Sendable {
    public let path: String
    public let content: String
    public let offset: Int
    public let nextOffset: Int
    public let totalBytes: Int
    public let hasMore: Bool
    public let snapshot: String
  }
  public struct WorkspaceDiff: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case captured, unavailable, timeout, failed }
    public let status: Status
    public let reason: String?
    public let patch: String
    public let truncated: Bool
  }
  public struct SessionStatus: Decodable, Sendable {
    public enum State: String, Decodable, Sendable { case running, waiting, not_observed }
    public let state: State
    public let observedAt: String
  }
  public enum WorkspaceResult: Decodable, Sendable {
    case list(WorkspaceListing), file(WorkspaceFile), diff(WorkspaceDiff), status(SessionStatus)
    enum CodingKeys: String, CodingKey { case action, listing, file, diff, state, observedAt }
    public init(from decoder: Decoder) throws {
      let values = try decoder.container(keyedBy: CodingKeys.self)
      switch try values.decode(WorkspaceQuery.Action.self, forKey: .action) {
      case .list: self = .list(try values.decode(WorkspaceListing.self, forKey: .listing))
      case .file: self = .file(try values.decode(WorkspaceFile.self, forKey: .file))
      case .diff: self = .diff(try values.decode(WorkspaceDiff.self, forKey: .diff))
      case .status: self = .status(try SessionStatus(from: decoder))
      }
    }
  }
  private struct WorkspaceRequest: Encodable { let op = "workspace"; let query: WorkspaceQuery }
  private struct WorkspaceResponse: Decodable { let workspace: WorkspaceResult?; let error: String? }

  public static func relayWorkspace(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                                    query: WorkspaceQuery) async throws -> WorkspaceResult {
    let request = try JSONEncoder().encode(WorkspaceRequest(query: query))
    let bytes = try await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity,
      request: request, responseLimit: 513 * 1024, lane: .bulk)
    let response = try JSONDecoder().decode(WorkspaceResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    guard let workspace = response.workspace else { throw ProbeError.unexpectedReply }
    return workspace
  }
}
