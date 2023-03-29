import express from "express"
import { join } from "path"
import yt from "./youtube"
import logger from "winston"

export default () => {
  const svr = express()

  svr.get("/", async (_, res) => {
    res.sendFile(join(__dirname, "assets/index.html"))
  })

  svr.get("/auth", (_, res) => {
    res.redirect(yt.auth.getAuthUrl())
  })

  svr.get("/callback", async (req, res) => {
    const { code } = req.query
    logger.info("auth code received")
    const tokens = await yt.auth.getTokens(code as string)
    logger.info("tokens received")
    await yt.auth.setCredentials(tokens)
    res.redirect("/")
  })

  return svr
}
