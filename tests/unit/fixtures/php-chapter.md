---
book: The Complete Modern PHP Engineering Book
volume: 1
volume_title: THE PHP MENTAL MODEL
chapter: 1
title: What PHP Actually Is
slug: what-php-actually-is
status: complete
summary: ../../_ai/chapter-summaries/001-what-php-actually-is-summary.md
---

# Chapter 1 — What PHP Actually Is

## Why This Matters

Many PHP problems begin with an incomplete definition of PHP.

If PHP is understood only as a collection of language features, an engineer may learn variables, classes, and frameworks while missing the conditions under which the code runs. They may know how to write a controller but not know which process executes it, what survives between requests, where input entered the system, or why two simultaneous requests can interfere with one another.

If PHP is understood only as “the thing that generates HTML,” the engineer may build an HTTP application successfully but struggle when the same domain logic needs to run from a queue worker, a command-line script, a scheduled task, or an import process.

The useful definition is larger:

> PHP is a programming language, executed by a runtime, commonly used as part of server-side applications.

Those three parts are related, but they are not the same thing. The language describes what PHP code means. The runtime turns that code into behavior. The application environment determines how the runtime is started, what it can access, and what happens to its output.

That distinction is the foundation for the rest of this book. It lets us ask precise questions instead of attributing every behavior to “PHP” as if the language, interpreter, web server, database, and operating system were one object.

## Mental Model

Think of a PHP application as a set of layers:

```text
Your PHP source code
        ↓
PHP language rules
        ↓
PHP runtime and extensions
        ↓
Process model and configuration
        ↓
Operating system and external services
```

At the top is the code a developer writes. It contains expressions, functions, objects, control flow, and calls to libraries. The language defines the meaning of those constructs.

Below that is the runtime. A PHP executable reads PHP source, understands it, and executes it. The runtime manages values, calls functions, handles errors and exceptions, and provides built-in functionality. Extensions connect the runtime to capabilities such as filesystems, networking, databases, cryptography, and image processing.

Below the runtime is the process model. The same PHP code behaves differently depending on whether it is launched as a one-off command, invoked for an HTTP request through PHP-FPM, or kept alive inside a worker process. Configuration also belongs here: memory limits, enabled extensions, error reporting, time zones, and other settings can change observable behavior.

At the bottom are the operating system and services outside PHP. A database can reject a query. A filesystem can run out of space. A network connection can time out. A process can be terminated. These are not merely unusual edge cases; they are part of the environment in which PHP code has to be correct.

This layered model prevents two common mistakes:

1. assuming that a behavior belongs to the language when it actually comes from the runtime or configuration;
2. assuming that correct PHP code can guarantee success when the database, filesystem, network, or process supervisor can still fail.

## Core Concept

### PHP is a language

The language is the part a programmer writes and reasons about directly. It includes syntax and semantics such as:

- how variables are assigned;
- what values and types exist;
- how expressions are evaluated;
- how functions and methods are called;
- how errors and exceptions propagate;
- how objects, interfaces, and enums behave.

When the language says that an expression produces a value, or that an exception can propagate through a call stack, that is a statement about the meaning of PHP programs. These rules are useful even when the program is not connected to the web.

### PHP is a runtime

Source code is not behavior by itself. A runtime must load it and execute it.

The runtime is responsible for the machinery that makes language constructs real: representing values in memory, calling functions, allocating and releasing memory, executing compiled instructions, and connecting user code to internal functions and extensions. Later chapters will examine these mechanisms in detail, including zvals, HashTables, opcodes, the Zend virtual machine, and OPcache.

For now, the important idea is simple:

> When PHP code runs, the runtime is an active participant in what the program does.

This is why two pieces of code that look equally simple can have very different memory costs, execution costs, or failure modes. A loop over a small value and a loop over ten million values are both valid language constructs, but the runtime must allocate, access, compare, and eventually release those values.

### PHP is part of an application environment

Production PHP is rarely just a standalone executable. It is usually one component in a larger path:

```text
Browser or API client
        ↓
Web server / reverse proxy
        ↓
PHP-FPM or another PHP entry point
        ↓
Application code
        ↓
Database, cache, filesystem, or external API
```

The exact path varies. A command-line program may start at a shell instead of an HTTP request. A queue worker may receive a message instead of a browser request. A test may invoke application code without a web server at all.

The application is still PHP, but the surrounding lifecycle has changed. Input arrives differently, output has a different consumer, and the rules about process lifetime may be different. A request handler can often rely on the process ending soon after the response; a long-running worker cannot make that assumption.

### A minimal example

Consider this file:

```php
<?php

declare(strict_types=1);

$message = 'Hello from PHP';

echo $message, PHP_EOL;
```

At the language level, this example declares a variable, assigns it a string, and evaluates an output operation. `declare(strict_types=1);` is a source-level instruction that makes scalar type declarations strict for calls made from this file; it does not turn PHP variables into statically typed variables.

At the runtime level, PHP must read the file, recognize the opening PHP tag, create or retrieve the string value, execute the output operation, and write bytes to the process's output stream.

At the environment level, the result depends on how the file is launched. From a terminal, the bytes appear in standard output. Through a web entry point, those bytes may become part of an HTTP response. The source code is the same, but the consumer of the output is different.

This is a small example, but it already demonstrates the book's main habit: separate the code's meaning from the machinery and environment that make its effects visible.

## How It Works

The path from a PHP file to an observable result is easier to understand as a pipeline:

```text
source bytes
    ↓
lexing and parsing
    ↓
compiled representation
    ↓
execution by the Zend VM
    ↓
output, return value, exception, or external side effect
```

This diagram is deliberately simplified. It is a mental model for reasoning about a running program, not a promise that every version or execution mode exposes exactly these stages as separate long-lived objects.

### 1. The runtime receives source

An entry point identifies what should run. For a CLI command, the PHP executable can be given a file, code supplied on the command line, or input from standard input. For a web request, a server integration selects a script or front controller and passes request data through the configured interface. A worker may load its bootstrap code once and then receive many messages.

Before the language can do anything useful, the runtime must be able to read the source and its dependencies. File permissions, the current working directory, include paths, autoloaders, and configuration can all affect this stage. A failure here is not the same as a bug in a conditional statement that would have run later.

### 2. The source is interpreted as PHP syntax

PHP source is text, but the runtime cannot execute arbitrary text directly. It must recognize tokens and grammatical structure: names, literals, operators, statements, declarations, and expressions. The parser determines whether those pieces form a valid PHP program and builds an internal representation of their structure.

For example:

```php
$total = $price * $quantity;
```

The runtime has to identify two variables, an assignment, a multiplication operator, and the relationship between them. It is not merely searching for the characters `*` and `=`. The surrounding syntax determines what those characters mean.

If the source is malformed, execution normally stops before the program reaches its ordinary statements. This distinction is useful when diagnosing errors: a parse error is a failure to understand the program's structure, while an exception thrown by a successfully parsed statement is a failure during execution.

### 3. The program is compiled into executable instructions

After parsing, the runtime turns the program's structure into an executable internal form. In PHP's ordinary implementation this includes Zend opcodes, which are instructions that the Zend virtual machine can execute. The exact representation and optimization behavior are implementation details and can change between PHP versions.

The important engineering consequence is that PHP execution is not best modeled as repeatedly rereading each source line and immediately translating it in isolation. The runtime first prepares a representation of the program, then executes that representation. OPcache can preserve compiled results between requests in supported deployments, reducing repeated preparation work, but it does not change the language semantics that the program is expected to follow.

Consider this code:

```php
<?php

declare(strict_types=1);

function subtotal(int $unitPrice, int $quantity): int
{
    return $unitPrice * $quantity;
}

echo subtotal(1250, 3), PHP_EOL;
```

Compilation prepares the function declaration and the operations needed for the call. It does not, by itself, calculate the final subtotal. The value `3750` is produced when the prepared program executes with those arguments.

### 4. The virtual machine executes the instructions

The Zend virtual machine evaluates expressions, performs assignments, calls functions, invokes methods, branches through control flow, and handles the results of those operations. During this work it creates and manipulates runtime values, consults symbol and class information, and calls internal functions supplied by PHP or extensions.

Execution is where the program's input becomes behavior. A function can return normally, throw an exception, emit output, mutate an object, write to a file, send a query, or fail because a dependency is unavailable. The source file alone does not tell us which of these outcomes occurred; the inputs and environment matter too.

The call stack gives execution a shape. When `checkout()` calls `reserveStock()`, the second function runs with its own parameters and local variables while the first function waits for its result. A returned value travels back to the caller. An uncaught exception travels outward through the stack until a handler catches it or the entry point reports an uncaught failure.

At this level, the details of zvals, references, function-call frames, and garbage collection explain important costs and behaviors. They are intentionally deferred to Volume IV, where those mechanisms can be examined without mixing them into the first mental model.

### 5. The result crosses an application boundary

The final step is not always “print HTML.” A PHP program may produce one or more of several outcomes:

- bytes written to standard output or an HTTP response body;
- a return code observed by the shell or a process supervisor;
- a value returned to another function or framework layer;
- an exception recorded, translated, or allowed to terminate the entry point;
- an external side effect such as a database write, file operation, cache update, or message publication.

The same application operation can have different outer translations. A CLI command might write a progress message and return exit code `0`. An HTTP controller might turn the same successful domain result into JSON with status `200`. A queue worker might acknowledge a message only after the operation succeeds.

This is why output and side effects should be treated separately. A script can print “done” and still fail to persist the data it claims to have processed. Conversely, a command can complete a useful database update without producing user-facing output. Correctness depends on the contract of the entry point, not merely on whether some bytes appeared on a screen.

### Parsing is not execution

The distinction between preparation and execution explains several everyday observations:

```php
<?php

echo 'before', PHP_EOL;

throw new RuntimeException('stop here');

echo 'after', PHP_EOL;
```

The first output operation can run before the exception is thrown. The later operation is never reached. The source can be structurally valid even though execution ends with an exception. A syntax error in the same file would prevent this ordinary execution path from starting at all.

That difference also affects error handling. A `try`/`catch` block can handle an exception raised while a statement executes. It cannot turn arbitrary malformed source into a valid program. The relevant question is always: did the failure happen while the runtime was reading and preparing the program, or after execution had begun?

### One request, one process, or many requests?

The pipeline exists in more than one lifecycle:

```text
CLI script:       start → load → execute → exit

Web request:      worker ready → initialize request → execute → send result → reset/finish request

Long-running job: start → bootstrap once → receive message → execute → release request state → repeat
```

The exact lifecycle depends on the runtime integration and application architecture. A typical PHP-FPM deployment uses worker processes that handle requests under a managed lifecycle. A long-running worker intentionally keeps a process alive across multiple jobs. That difference changes what “global state,” static state, open resources, cached objects, and memory growth mean operationally.

Code that is harmless when the process exits after one operation can become a leak or cross-job contamination problem when the process repeats. For example, a worker that appends every processed identifier to an array forever has a bounded cost per request only in a short-lived process; in a persistent process its memory usage grows with the number of jobs. The language statement is the same. The process lifetime changes the engineering result.

### What this model does—and does not—claim

The pipeline helps us assign questions to the right layer:

| Question | Most relevant layer |
| --- | --- |
| Is this expression valid PHP? | Language syntax and semantics |
| Why did this value or exception appear? | Language rules and runtime execution |
| Why is the compiled code reused? | Runtime integration and OPcache configuration |
| Why did the script lack permission to write? | Operating system and process environment |
| Why did the response take ten seconds? | Application, runtime, database, network, or infrastructure |
| Why did a second job see stale state? | Process lifetime and application state management |

The model is not a claim that every performance problem is a compiler problem, or that the Zend VM is the only component that matters. It is a map for choosing the next question. Later volumes add detail to each region of the map.

## What PHP Does

PHP can produce many kinds of output. HTML is one possibility, but it can also produce JSON, plain text, a file, a generated image, a database change, a queue message, or no direct output at all.

The official PHP documentation describes PHP as a general-purpose scripting language especially suited to web development and embeddable in HTML. That description explains PHP's historical center of gravity, not a limitation that prevents it from being used for command-line programs, workers, and other server-side tasks. The execution context determines how the program is started and how its results are consumed.

This matters when designing boundaries. A function that calculates whether a reservation conflicts with another reservation should not need to know whether it was called from an HTTP controller, a CLI command, or a queue worker. The outer layer can translate HTTP input or a message into domain values, call the logic, and translate the result back into an HTTP response or an acknowledgment.

That separation is not ceremony. It makes the same rule testable in isolation and reusable across entry points.

## What Zend Does

“Zend” is often used as shorthand for the engine underneath PHP. At a conceptual level, the Zend Engine is the runtime machinery that executes PHP programs and provides the structures and operations required by the language.

It is useful to keep the distinction precise:

- PHP is the language and ecosystem the developer uses.
- The Zend Engine is the core execution engine used by the PHP implementation.
- Extensions add or expose capabilities around that core.
- PHP-FPM, a web server, a process supervisor, a database, and the operating system are surrounding components, not interchangeable names for the engine.

The boundaries are important because a problem can originate at any of them. A type error may be language behavior. A memory increase may involve runtime allocation or application retention. A failed database call may be a service or network failure. A request that never reaches PHP may be a proxy or routing problem.

We will return to this boundary repeatedly. Understanding it is more valuable than memorizing an isolated list of internal structures.

## Practical Example

Suppose an application accepts a reservation request. The business rule is small: a requested interval must not overlap an existing interval. The rule itself is computation. Reading the request body, querying existing reservations, sending JSON, and recording an audit event are boundary concerns.

A useful first cut keeps the computation independent of the entry point:

```php
<?php

declare(strict_types=1);

final readonly class TimeRange
{
    public function __construct(
        public int $startsAt,
        public int $endsAt,
    ) {
        if ($startsAt >= $endsAt) {
            throw new InvalidArgumentException('A range must have positive length.');
        }
    }

    public function overlaps(self $other): bool
    {
        return $this->startsAt < $other->endsAt
            && $other->startsAt < $this->endsAt;
    }
}

function canReserve(TimeRange $requested, array $existing): bool
{
    foreach ($existing as $reserved) {
        if ($requested->overlaps($reserved)) {
            return false;
        }
    }

    return true;
}
```

This function does not know whether its values came from JSON, a form, a test fixture, or a queue message. It does not print a response or open a database connection. Its direct cost is O(n) time for `n` existing ranges and O(1) additional space, excluding the input collection and the objects already supplied to it.

The boundary layer can then decide what to do with the result:

```php
$requested = new TimeRange(
    startsAt: 1_720_000_000,
    endsAt: 1_720_003_600,
);

if (!canReserve($requested, $existingRanges)) {
    // An HTTP adapter could return a conflict response.
    // A CLI adapter could print a message and choose an exit code.
    // A worker could reject or reschedule the message.
}
```

The example is intentionally incomplete at the database boundary. If two requests can reserve the same resource concurrently, checking in PHP alone is not enough: both processes can observe availability before either writes. The database transaction, constraint, or locking strategy belongs to the later database and concurrency discussions. The mental-model lesson comes first: local computation and shared-state coordination are different problems.

## Bad Example

A boundary-blurring implementation might do everything in one function:

```php
function handleReservation(): void
{
    $payload = json_decode(file_get_contents('php://input'), true);

    $database = new PDO(/* ... */);
    $rows = $database->query('SELECT starts_at, ends_at FROM reservations');

    // Parse input, decide availability, write a row, and emit JSON here.
    echo json_encode(['ok' => true]);
}
```

The problem is not that `json_decode`, `PDO`, or JSON output are inherently wrong. The problem is that one function now combines several contracts and failure domains. It is harder to test the reservation rule without constructing an HTTP-like environment, harder to reuse it from a command, and easier to report success before a write or transaction has actually succeeded.

## Better Example

Separate the decision from the adapter and make success mean something precise:

```php
interface ReservationStore
{
    /** @return list<TimeRange> */
    public function forResource(int $resourceId): array;

    public function save(int $resourceId, TimeRange $range): void;
}

final readonly class ReservationService
{
    public function __construct(private ReservationStore $store)
    {
    }

    public function reserve(int $resourceId, TimeRange $requested): void
    {
        $existing = $this->store->forResource($resourceId);

        if (!canReserve($requested, $existing)) {
            throw new DomainException('The resource is already reserved.');
        }

        $this->store->save($resourceId, $requested);
    }
}
```

This is a better boundary for unit tests and reuse, but it is not yet a complete concurrency solution. An interface can isolate the service from a particular storage implementation; it cannot remove the storage system's consistency rules. A senior engineer asks what guarantee `save()` provides and whether the read-then-write sequence is atomic under the expected load.

## Testing

The pure part of the example can be tested without PHP-FPM, a web server, or a database:

```php
<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class TimeRangeTest extends TestCase
{
    public function testAdjacentRangesDoNotOverlap(): void
    {
        $first = new TimeRange(10, 20);
        $second = new TimeRange(20, 30);

        self::assertFalse($first->overlaps($second));
    }

    public function testContainedRangeOverlaps(): void
    {
        $existing = new TimeRange(10, 30);
        $requested = new TimeRange(15, 20);

        self::assertTrue($existing->overlaps($requested));
    }
}
```

An adapter test should separately verify translation: malformed input becomes a client error, a domain conflict becomes the intended conflict response, and an unexpected storage failure is not falsely reported as success. The exact test tools belong in Volume XI; the structural point is that a smaller boundary gives each test one reason to fail.

## Common Mistakes

### Treating all failures as PHP failures

A syntax error, a type error, an unavailable extension, a database timeout, and a reverse-proxy rejection are different events. They need different evidence and often different owners.

### Assuming request state is automatically shared

Two PHP requests may run in different worker processes or at different times. A variable in one request is not a reliable communication channel for another request. Shared state requires an explicit medium such as a database, cache, filesystem, or message broker, together with a consistency and failure strategy.

### Confusing output with completion

Writing a success response before a side effect is durable creates a misleading contract. Decide when the operation is complete, then produce the corresponding output or acknowledgment.

### Using implementation details as language guarantees

The existence of Zend opcodes and a Zend VM is useful for understanding the standard PHP implementation. It does not mean every internal representation, optimization, or memory layout is a portable application-level contract. Mark such claims as implementation-specific and verify them against the relevant PHP version when they matter.

### Ignoring process lifetime

Globals, static caches, open resources, and accumulated arrays have different risks in a short-lived request and a long-running worker. Test the lifecycle you deploy, not only the lifecycle that is convenient locally.

## Senior Engineer Thinking

When someone says “PHP is slow,” “PHP lost my variable,” or “PHP caused the request to fail,” ask which layer is actually responsible.

A useful investigation starts with questions such as:

- What code ran?
- Which PHP executable or runtime configuration ran it?
- What was the process model?
- What input did the process receive?
- What output or side effect was expected?
- Which external dependency was involved?
- Did the failure occur in PHP, in an extension, or outside the process?

This is not pedantry. It narrows the search space. It also prevents fixes at the wrong layer—for example, changing a PHP loop when the real bottleneck is a database query, or adding a retry in application code when the operation is not safe to repeat.

## Exercises

1. Take a small HTTP endpoint you have built and identify its input boundary, computation, external side effects, output contract, and process model.
2. Run the same domain operation from a CLI command and an HTTP adapter. Record which parts of the code must change and which should remain identical.
3. For the reservation example, list the failure that can occur at each layer: parsing, validation, computation, database access, response writing, and process termination.
4. Modify the example so a `TimeRange` uses `DateTimeImmutable` instead of integer timestamps. Explain what becomes clearer and what costs or ambiguities are introduced.

## Review Questions

1. What is the difference between the PHP language and the PHP runtime?
2. Why is “PHP generated HTML” an incomplete description of a PHP application?
3. What is the conceptual difference between parsing/compilation and execution?
4. Why can a syntactically valid program still fail before producing its intended result?
5. Why does process lifetime matter for mutable state and memory usage?
6. Why is a successful `echo` not proof that a database side effect succeeded?
7. Which claims about Zend opcodes should be treated as implementation-specific?

## Summary

PHP should be understood through three connected layers: the language, the runtime, and the application environment. The language defines what source code means. The runtime executes that code and manages values, calls, memory, and extensions. The surrounding environment determines how PHP starts, what it can access, and how failures outside the process affect the result.

The practical consequence is a habit of precise attribution. Before changing code, identify which layer controls the behavior. That habit will guide the rest of this book—from variables and arrays, through the Zend Engine, databases, concurrency, and production operations.

## Sources and Further Reading

- [PHP Manual: Introduction](https://www.php.net/intro)
- [PHP Manual: Basic syntax](https://www.php.net/manual/en/language.basic-syntax.php)
- [PHP Manual: Language Reference](https://www.php.net/manual/en/langref.php)
