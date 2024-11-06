const { ref, getDownloadURL } = require('firebase/storage');
const Post = require('../models/post.model');
const PostImg = require('../models/postImg.model');
const User = require('../models/user.model');
const AppError = require('../utils/appError');
const { storage } = require('../utils/firebase');

class PostService {
  async findPost(id) {
    try {
      const post = await Post.findOne({
        where: {
          id,
          status: 'active',
        },
        attributes: {
          exclude: ['userId', 'status'],
        },
        include: [
          {
            model: User,
            attributes: { exclude: ['password', 'passwordChangedAt'] },
          },
          {
            model: PostImg,
          },
        ],
      });
      if (!post) {
        throw new AppError('Post not found! 🧨', 404);
      }
      return post;
    } catch (error) {
      throw new Error(error);
    }
  }
  async downloadImgsPost(post) {
    try {
      const imgRefUserProfile = ref(storage, post.user.profileImgUrl);
      const urlProfileUser = await getDownloadURL(imgRefUserProfile);
      post.user.profileImgUrl = urlProfileUser;

      const postImgPromise = post.postImgs.map(async (postImg) => {
        const imgRef = ref(storage, postImg.postImgUrl);
        const imgDownloadUrl = await getDownloadURL(imgRef);
        postImg.postImgUrl = imgDownloadUrl;
        return postImg;
      });
      await Promise.all(postImgPromise);
      return post;
    } catch (error) {
      throw new Error(error);
    }
  }
}

module.exports = PostService;
