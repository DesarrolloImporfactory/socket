class Sockets {
  constructor(io) {
    this.io = io;
  }

  socketEvents() {
    /* this.io.on('connection', async (socket) => {
      socket.on('new-post', async ({ id }) => {
        try {
          const post = await this.postService.findPost(id);
          const newPost = await this.postService.downloadImgsPost(post);
          socket.broadcast.emit('render-new-post', newPost);
        } catch (error) {
          throw new Error(error);
        }
      });
    }); */
  }
}

module.exports = Sockets;
