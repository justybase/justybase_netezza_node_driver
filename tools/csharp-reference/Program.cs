using System.Globalization;
using System.Text.Json;
using JustyBase.NetezzaDriver;

// Usage:
//   CSharpReference <sql>              single query -> {"columns":[],"rows":[]}
//   CSharpReference --batch            JSON array of SQL from stdin -> JSON array of results
//   CSharpReference --batch <file>     JSON array of SQL from file -> JSON array of results
// Batch result per query: {"columns":[],"types":[],"rows":[],"error":null}
// or {"columns":[],"types":[],"rows":[],"error":"..."}.
// One connection is reused for the whole batch; a failing query does not abort the batch.
var batchQueries = TryParseBatchArgs(args, out var batchFile, out var usageError);
if (usageError is not null)
{
    Console.Error.WriteLine(usageError);
    return 2;
}

var host = RequireEnvironment("NZ_DEV_HOST");
var database = Environment.GetEnvironmentVariable("NZ_DEV_DATABASE")
    ?? Environment.GetEnvironmentVariable("NZ_DEV_DB")
    ?? "JUST_DATA";
var user = RequireEnvironment("NZ_DEV_USER");
var password = RequireEnvironment("NZ_DEV_PASSWORD");
var port = int.TryParse(Environment.GetEnvironmentVariable("NZ_DEV_PORT"), out var configuredPort)
    ? configuredPort
    : 5480;

try
{
    if (batchQueries is null)
    {
        var single = RunSingle(user, password, host, database, port, args[0]);
        if (single.Error is not null)
        {
            Console.Error.WriteLine(single.Error);
            return 1;
        }
        Console.WriteLine(
            JsonSerializer.Serialize(new { columns = single.Columns, types = single.Types, rows = single.Rows }, JsonOptions()));
        return 0;
    }

    var queries = await LoadBatchQueriesAsync(batchQueries, batchFile);
    using var connection = new NzConnection(user, password, host, database, port);
    connection.Open(ClientTypeId.SqlDotnet);
    var results = queries.Select(query => RunBatched(connection, query)).ToList();
    Console.WriteLine(JsonSerializer.Serialize(results, JsonOptions()));
    return results.All(r => r.Error is null) ? 0 : 1;
}
catch (Exception exception)
{
    Console.Error.WriteLine($"{exception.GetType().Name}: {exception.Message}");
    return 1;
}

static List<string>? TryParseBatchArgs(string[] cliArgs, out string? batchFile, out string? error)
{
    batchFile = null;
    error = null;
    if (cliArgs.Length == 1 && cliArgs[0] == "--batch")
    {
        return new List<string>();
    }
    if (cliArgs.Length == 2 && cliArgs[0] == "--batch" && !string.IsNullOrWhiteSpace(cliArgs[1]))
    {
        batchFile = cliArgs[1];
        return new List<string>();
    }
    if (cliArgs.Length == 1 && !string.IsNullOrWhiteSpace(cliArgs[0]) && cliArgs[0] != "--batch")
    {
        return null;
    }
    error = "Usage: CSharpReference <sql> | CSharpReference --batch [file.json]";
    return new List<string>();
}

static async Task<List<string>> LoadBatchQueriesAsync(List<string> parsed, string? batchFile)
{
    if (batchFile is not null)
    {
        var fileJson = await File.ReadAllTextAsync(batchFile);
        return JsonSerializer.Deserialize<List<string>>(fileJson)
            ?? throw new InvalidOperationException("Batch file must contain a JSON array of SQL strings.");
    }
    if (parsed.Count == 0)
    {
        var stdinJson = await Console.In.ReadToEndAsync();
        if (string.IsNullOrWhiteSpace(stdinJson))
        {
            throw new InvalidOperationException("Batch mode requires a JSON array of SQL strings on stdin or in a file.");
        }
        return JsonSerializer.Deserialize<List<string>>(stdinJson)
            ?? throw new InvalidOperationException("Batch stdin must contain a JSON array of SQL strings.");
    }
    return parsed;
}

static QueryResult RunSingle(string user, string password, string host, string database, int port, string sql)
{
    using var connection = new NzConnection(user, password, host, database, port);
    connection.Open(ClientTypeId.SqlDotnet);
    return RunBatched(connection, sql);
}

static QueryResult RunBatched(NzConnection connection, string sql)
{
    try
    {
        using var command = connection.CreateCommand(sql);
        using var reader = command.ExecuteReader();

        var columns = Enumerable.Range(0, reader.FieldCount)
            .Select(reader.GetName)
            .ToArray();
        var types = Enumerable.Range(0, reader.FieldCount)
            .Select(column =>
            {
                try
                {
                    return reader.GetFieldType(column).Name;
                }
                catch
                {
                    return "?";
                }
            })
            .ToArray();
        var rows = new List<object?[]>();

        while (reader.Read())
        {
            var row = new object?[reader.FieldCount];
            for (var column = 0; column < reader.FieldCount; column++)
            {
                row[column] = EncodeValue(reader.IsDBNull(column) ? null : reader.GetValue(column));
            }
            rows.Add(row);
        }

        return new QueryResult(columns, types, rows, null);
    }
    catch (Exception exception)
    {
        return new QueryResult([], [], [], $"{exception.GetType().Name}: {exception.Message}");
    }
}

static string RequireEnvironment(string name) =>
    Environment.GetEnvironmentVariable(name)
    ?? throw new InvalidOperationException($"Environment variable {name} is required.");

static object? EncodeValue(object? value) => value switch
{
    null => null,
    DateTime dateTime => new { type = "datetime", value = dateTime.ToString("O", CultureInfo.InvariantCulture) },
    DateTimeOffset dateTimeOffset => new { type = "datetimeoffset", value = dateTimeOffset.ToString("O", CultureInfo.InvariantCulture) },
    TimeSpan timeSpan => new { type = "timespan", value = timeSpan.ToString("c", CultureInfo.InvariantCulture) },
    byte[] bytes => new { type = "bytes", value = Convert.ToHexString(bytes) },
    IFormattable formattable => new { type = value.GetType().Name, value = formattable.ToString(null, CultureInfo.InvariantCulture) },
    _ => new { type = value.GetType().Name, value = value.ToString() ?? string.Empty },
};

static JsonSerializerOptions JsonOptions() => new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

sealed record QueryResult(string[] Columns, string[] Types, List<object?[]> Rows, string? Error);
