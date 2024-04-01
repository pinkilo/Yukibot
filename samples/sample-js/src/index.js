import "dotenv/config"
import process from "process"
import { yuki } from "@pinkilo/yukibot"

async function main() {
  const bot = await yuki((y) => {
    y.logLevel = "http" // info, debug, error
    y.yukiConfig.name = "MyBot"
    y.yukiConfig.prefix = /^>/
    y.yukiConfig.test = !process.env.NODE_ENV || process.env.NODE_ENV === "test"
    y.googleConfig = {
      clientId: process.env.G_CLIENT_ID,
      clientSecret: process.env.G_CLIENT_SECRET,
      redirectUri: process.env.G_REDIRECT_URI,
    }
    y.tokenLoader = async () => ({
      // provide a way to load tokens, e.g., from file or a database
    })
    y.userCacheLoader = async () => ({
      // use this to load users saved to file or a DB
    })

    // Add a message listener which greets a chatter
    y.onMessage(({ authorDetails: { displayName } }) => {
      y.sendMessage(`Hello there, ${displayName}!`)
    })

    // add a command which responds to `>greet` with "Hello There"
    y.command((cmd) => {
      cmd.name = "greet"
      cmd.invoke = async () => {
        await y.sendMessage("Hello There")
      }
    })

    extractedSetup(y)
  })

  bot.express.listen(3000, () => console.log(`http://localhost:${3000}`))
  bot.onAuthUpdate(() => bot.restart())
}

/**
 * You can extract the setup to one or more functions to sort your code!
 *
 * @param {YukiBuilder} builder
 */
async function extractedSetup(builder) {
  // add a message listener which removes itself if the message says "get out"
  builder.onMessage(
    ({ snippet: { displayMessage } }) => {
      return displayMessage.match(/^get\s+out$/)
    },
    (_, match) => match !== null
  )

  // add a passive, which acts like a message listener with a predicate and memory
  builder.passive(
    async (msg, tokens, self) => {
      /* Predicate, if this returns TRUE then the execution logic will run */
      return true
    },
    async (msg, tokens, self) => {
      /* execution logic, only runs if the predicate returns true */
    }
  )
}

main()
