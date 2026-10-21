import Foundation

extension G0Transport {
  public struct FileDownloadQuery: Encodable, Sendable {
    public enum Action: String, Encodable, Sendable { case open, read, close }
    public let action: Action
    let cwd: String
    let target: String?
    let id: String?
    let offset: Int?
    public static func open(cwd: String, target: String) -> Self {
      .init(action: .open, cwd: cwd, target: target, id: nil, offset: nil)
    }
    public static func read(cwd: String, id: String, offset: Int) -> Self {
      .init(action: .read, cwd: cwd, target: nil, id: id, offset: offset)
    }
    public static func close(cwd: String, id: String) -> Self {
      .init(action: .close, cwd: cwd, target: nil, id: id, offset: nil)
    }
  }

  public struct FileDownloadPage: Decodable, Sendable {
    public let id: String
    public let name: String
    public let mimeType: String?
    public let totalBytes: Int?
    public let offset: Int
    public let nextOffset: Int
    public let data: String
    public let hasMore: Bool

    public func bytes(expectedOffset: Int, expectedID: String?) throws -> Data {
      guard !id.isEmpty, id.count <= 128, expectedID == nil || expectedID == id,
            !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0"),
            offset == expectedOffset, offset >= 0,
            let bytes = Data(base64Encoded: data), bytes.count <= 256 * 1024,
            offset <= Int.max - bytes.count, nextOffset == offset + bytes.count,
            !hasMore || nextOffset > offset,
            totalBytes == nil || (totalBytes! >= nextOffset && (hasMore || totalBytes! == nextOffset))
      else { throw ProbeError.unexpectedReply }
      return bytes
    }
  }

  public enum FileDownloadResult: Decodable, Sendable {
    case page(FileDownloadPage), closed
    private enum CodingKeys: String, CodingKey { case kind }
    private enum Kind: String, Decodable { case page, closed }
    public init(from decoder: Decoder) throws {
      let values = try decoder.container(keyedBy: CodingKeys.self)
      switch try values.decode(Kind.self, forKey: .kind) {
      case .page: self = .page(try FileDownloadPage(from: decoder))
      case .closed: self = .closed
      }
    }
  }

  private struct FileDownloadRequest: Encodable { let op = "fileDownload"; let query: FileDownloadQuery }
  private struct FileDownloadResponse: Decodable {
    let fileDownload: FileDownloadResult?
    let executionTarget: ExecutionTargetBinding?
    let error: String?
  }
  public static func relayFileDownload(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                                       query: FileDownloadQuery) async throws -> FileDownloadResult {
    let request = try JSONEncoder().encode(FileDownloadRequest(query: query))
    // Opening an HTTP resource can have server-side effects even for GET. A
    // lost reply must not trigger an automatic re-request or advance a stream.
    let bytes = try await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity,
      request: request, responseLimit: 513 * 1024, lane: .bulk, replayable: false)
    let response = try JSONDecoder().decode(FileDownloadResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    if let target = endpoint.executionTarget, response.executionTarget != target { throw ProbeError.unexpectedReply }
    guard let file = response.fileDownload else { throw ProbeError.unexpectedReply }
    return file
  }
}
