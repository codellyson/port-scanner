import { Command } from 'commander';
import { scanPorts, filterPorts } from '../core/scanner';
import { FilterOptions } from '../core/types';
import { formatTable, formatJson, formatSummary } from './formatter';
import { startServer } from '../web/server';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('ports')
    .description('A CLI tool to list all running ports on your system')
    .version('1.0.0');

  program
    .command('list')
    .description('List all open ports on the system')
    .option('-p, --port <number>', 'Filter by specific port number')
    .option('-P, --protocol <protocol>', 'Filter by protocol (tcp/udp)')
    .option('-s, --state <state>', 'Filter by state (LISTEN, ESTABLISHED, etc.)')
    .option('-n, --process <name>', 'Filter by process name')
    .option('-S, --source <path>', 'Filter by source executable path')
    .option('-j, --json', 'Output as JSON')
    .option('--no-summary', 'Hide summary')
    .action((options) => {
      try {
        const result = scanPorts();
        let ports = result.ports;

        // Apply filters
        const filters: FilterOptions = {};
        if (options.port) filters.port = parseInt(options.port, 10);
        if (options.protocol) filters.protocol = options.protocol.toLowerCase() as 'tcp' | 'udp';
        if (options.state) filters.state = options.state;
        if (options.process) filters.process = options.process;
        if (options.source) filters.source = options.source;

        ports = filterPorts(ports, filters);

        // Output
        if (options.json) {
          console.log(formatJson(ports));
        } else {
          console.log(formatTable(ports));
          if (options.summary !== false) {
            console.log(formatSummary(ports));
          }
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  program
    .command('web')
    .description('Start the web dashboard')
    .option('-p, --port <number>', 'Port for the web server', '3000')
    .option('-h, --host <host>', 'Host to bind to', 'localhost')
    .action((options) => {
      const port = parseInt(options.port, 10);
      startServer(port, options.host);
    });

  // Default action when no command is provided
  if (process.argv.length === 2) {
    // Show help if no arguments
    program.help();
  }

  return program;
}
