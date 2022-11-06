import * as core from '@actions/core';
import type {Dirent} from 'fs';
import fs from 'fs/promises';
import https from 'https';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/promise-function-async, @typescript-eslint/no-explicit-any
function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on('error', (err: any) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
async function run(): Promise<void> {
  try {
    const databaseBaseUrl = core.getInput('databaseBaseUrl', {required: true});
    const databaseUser = core.getInput('databaseUser', {required: true});
    const databasePassword = core.getInput('databasePassword', {
      required: true,
    });
    const databaseNamespace = core.getInput('databaseNamespace', {
      required: true,
    });
    const databaseDatabase = core.getInput('databaseDatabase', {
      required: true,
    });
    const workingDirectory = core.getInput('working-directory') ?? '.';
    const relativeMigrationsPath = path.join(
      workingDirectory,
      core.getInput('migrationsRelativePath') ?? 'migrations',
    );
    if (databaseNamespace.includes(';')) {
      throw new Error(`databaseNamespace can't contain ';'`);
    }
    if (databaseDatabase.includes(';')) {
      throw new Error(`databaseDatabase can't contain ';'`);
    }

    const files = await fs.readdir(relativeMigrationsPath, {
      withFileTypes: true,
      encoding: 'utf8',
    });
    const oneOffMigrations: [string, Dirent][] = [];
    const idempotentMigrations = [];
    for (const file of files) {
      if (!file.isFile()) {
        core.debug(`ignoring ${file} as it's not a file`);
        continue;
      }
      if (
        !(
          file.name.endsWith('.sql') ||
          file.name.endsWith('.surrealql') ||
          file.name.endsWith('.surql')
        )
      ) {
        core.debug(
          `ignoring ${file} as it dosen't end with .sql, .surrealql or .surql`,
        );
        continue;
      }
      const idResult = /^(?<id>\d+)/.exec(file.name);
      if (!idResult) {
        core.debug(`found idempotent migraiton ${file.name}`);
        idempotentMigrations.push(file);
      } else {
        const id = idResult[1];
        core.debug(`found one-off migration with id ${id} : ${file}`);
        oneOffMigrations.push([id, file]);
      }
    }

    const comparisonOptions = {numeric: true, sensitivity: 'base'};
    oneOffMigrations.sort((a, b) =>
      a[0].localeCompare(b[0], undefined, comparisonOptions),
    );
    idempotentMigrations.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, comparisonOptions),
    );

    type SurrealQLStatementResponse<T extends {}> = (
      | {
          status: 'OK';
          result: T;
        }
      | {
          status: 'ERR';
          detail: string;
        }
    ) & {
      time: string;
    };
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    const surQLClient = <TResult extends {}>(
      sql: string,
    ): Promise<SurrealQLStatementResponse<TResult>[]> => {
      return new Promise((res, rej) => {
        const req = https.request(new URL('sql', databaseBaseUrl), {
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(
              `${databaseUser}:${databasePassword}`,
            ).toString('base64')}`,
            NS: databaseNamespace,
            DB: databaseDatabase,
          },
          method: 'POST',
        });
        req.on('response', resp => {
          if (!resp.complete)
            return rej(new Error('complete response was not received'));
          if (
            resp.statusCode &&
            !(resp.statusCode >= 200 && resp.statusCode < 300)
          )
            return rej(
              new Error(
                `did not receive 2XX status, it was ${resp.statusCode}: ${resp.statusMessage}`,
              ),
            );
          res(
            // eslint-disable-next-line github/no-then
            streamToString(resp).then(async r => {
              try {
                return JSON.parse(r);
              } catch (e) {
                throw new Error(`unable to parse json: ${e}`);
              }
            }),
          );
        });
        req.write(sql, err => {
          if (err) return rej(err);
        });
      });
    };

    let previouslyRunOneOffMigrationsResult = (
      await surQLClient<{filename_prefix: string}[]>(
        'SELECT filename_prefix FROM migration;',
      )
    )[0];

    if (previouslyRunOneOffMigrationsResult.status !== 'OK') {
      const defineMigrationsResult = await surQLClient<
        {filename_prefix: string}[]
      >(
        `
        DEFINE NAMESPACE ${databaseNamespace};
        DEFINE DATABASE ${databaseDatabase};
        DEFINE TABLE migration SCHEMAFULL PERMISSIONS NONE;
        DEFINE FIELD filename_prefix ON TABLE migration TYPE string;
        `,
      );
      if (!defineMigrationsResult.every(r => r.status === 'OK')) {
        throw new Error(
          `unable to define migration table; ${defineMigrationsResult}`,
        );
      }

      previouslyRunOneOffMigrationsResult = (
        await surQLClient<{filename_prefix: string}[]>(
          'SELECT filename_prefix FROM migration;',
        )
      )[0];
      if (previouslyRunOneOffMigrationsResult.status !== 'OK') {
        throw new Error(
          `unable to fetch previously run migrations from db ${previouslyRunOneOffMigrationsResult}`,
        );
      }
    }

    const previouslyRunOneOffMigrations =
      previouslyRunOneOffMigrationsResult.result.map(e => e.filename_prefix);

    for (const [filenamePrefix, file] of oneOffMigrations) {
      if (previouslyRunOneOffMigrations.includes(filenamePrefix)) {
        core.debug(`skipping ${file} as it's be executed before`);
        continue;
      }
      const execResult = await surQLClient(
        `BEGIN TRANSACTION; ${await fs.readFile(
          path.join(relativeMigrationsPath, file.name),
          'utf-8',
        )}; CREATE migration SET filename_prefix = '${filenamePrefix}'; COMMIT TRANSACTION;`,
      );
      if (!execResult.every(r => r.status === 'OK')) {
        throw new Error(
          `Failed executing migration ${file.name}: ${JSON.stringify(
            execResult,
          )}`,
        );
      }
      core.info(`Executed one-off migration ${file.name} successfully`);
    }

    for (const file of idempotentMigrations) {
      const execResult = await surQLClient(
        `BEGIN TRANSACTION; ${await fs.readFile(
          path.join(relativeMigrationsPath, file.name),
          'utf-8',
        )}; COMMIT TRANSACTION;`,
      );
      if (!execResult.every(r => r.status === 'OK')) {
        throw new Error(
          `Failed executing migration ${file.name}: ${JSON.stringify(
            execResult,
          )}`,
        );
      }
      core.info(`Executed idempotent migration ${file.name} successfully`);
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
