#!/usr/bin/env node

import { createProgram } from './cli/commands';

const program = createProgram();
program.parse(process.argv);
