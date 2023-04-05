import { Router } from "express"
import { join } from "path"
import yt from "../youtube"
import logger from "winston"
import { MoneySystem as MS } from "../yuki"

export const pages = Router()
  .get("/", (_, res) => res.sendFile(join(__dirname, "public/index.html")))
  .get("/fox", (_, res) => res.sendFile(join(__dirname, "public/fox.html")))
  .get("/leaderboard", (_,
    res,
  ) => res.sendFile(join(__dirname, "public/leaderboard.html")))

export const oath = Router()
  .get("/auth", (_, res) => res.redirect(yt.auth.getAuthUrl()))
  .get("/callback", async (req, res) => {
    const { code } = req.query
    logger.info("auth code received")
    const tokens = await yt.auth.getTokens(code as string)
    logger.info("tokens received")
    await yt.auth.setCredentials(tokens)
    res.redirect("/")
  })

export const api = Router()
  .get("/leaderboard", async (_, res) => {
    const lb = MS.getLeaderboard()
    const channels = await yt.chat.getChannels(lb.map(([uid]) => uid))
    const hydratedLB = lb.map(([id, val]) => {
      return [channels.find(c => c.id === id)?.snippet.title || "unknown", val]
    })
    res.send(hydratedLB)
  })
